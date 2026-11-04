import type { Method } from './catalog.js';
import type { Config } from './config.js';
import { isObj } from './format.js';

export type Outcome = 'failed' | 'unknown';

/** An AroFlo or transport error with a short, model-facing message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 'unknown' = a write may or may not have been applied. */
    readonly outcome: Outcome = 'failed'
  ) {
    super(message);
  }
}

export interface RateState {
  minuteRemaining?: number;
  dailyRemaining?: number;
  /** Epoch ms when each window resets, from the X-RateLimit-*-Reset headers. */
  minuteResetAt?: number;
  dailyResetAt?: number;
}

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  /** The path is a collection (no ids): a 404 there points at a revoked token, not a missing record. */
  collection?: boolean;
  /** Template used in debug logs instead of the concrete path. */
  template?: string;
  /** Set only by the write tool, after the allowlist check and the user's confirm. */
  confirmedWrite?: boolean;
}

export interface ApiResponse {
  status: number;
  data: unknown;
}

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

const BURST = 10;
const MAX_WAIT_S = 30;
/** POSTs that change nothing (format conversion), allowed on a read-only server. */
const READ_ONLY_POSTS = new Set(['/idconversions']);
const UNKNOWN_HINT = 'The write may or may not have been applied: check with aroflo_get before retrying.';

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AroFloHttp {
  readonly rate: RateState = {};
  private tokens = BURST;
  private refilledAt: number;
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: Config,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly sleep: Sleep = realSleep,
    private readonly now: () => number = Date.now
  ) {
    this.refilledAt = this.now();
  }

  async request(method: Method, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    const token = this.cfg.token;
    if (!token) throw new ApiError(this.cfg.tokenError ?? 'no AroFlo token configured', 0);
    const write = method !== 'GET' && !(method === 'POST' && READ_ONLY_POSTS.has(path));
    if (write && (!this.cfg.writeOps.length || opts.confirmedWrite !== true)) {
      throw new ApiError(this.cfg.writeOps.length ? 'Refusing an unconfirmed write.' : 'Writes are disabled on this server (AROFLO_V2_WRITE_OPS is empty).', 0);
    }
    const base = new URL(this.cfg.baseUrl);
    const url = new URL(this.cfg.baseUrl + path);
    // Refuse anything URL parsing rewrote ("..", "%2e%2e", backslashes): the request must go exactly
    // where it was validated, on the configured host.
    if (!path.startsWith('/') || url.origin !== base.origin || url.pathname !== `${base.pathname.replace(/\/$/, '')}${path}`) {
      throw new ApiError(`Refusing path ${JSON.stringify(path)}: it does not resolve to itself.`, 0);
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': 'aroflo-v2-mcp/0.1'
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    for (let attempt = 1; ; attempt++) {
      await this.pace();
      const started = this.now();
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs)
        });
        this.readRate(res.headers);
        text = await res.text();
      } catch (err) {
        // No complete response: retry reads; for writes the outcome is unknown and we never resend.
        const reason = this.scrub(err instanceof Error ? (err.name === 'TimeoutError' ? `timed out after ${this.cfg.timeoutMs} ms` : err.message) : String(err));
        if (!write && attempt <= 2) {
          await this.sleep(400 * 2 ** attempt);
          continue;
        }
        throw write ? new ApiError(`No complete response from AroFlo (${reason}). ${UNKNOWN_HINT}`, 0, 'unknown') : new ApiError(`AroFlo request failed: ${reason}`, 0);
      }
      const data = parseJson(text);
      this.log(`${method} ${opts.template ?? path} ${res.status} ${this.now() - started}ms`);

      if (res.status === 429) {
        // Rejected before processing, so resending is safe even for a write. Long waits go back to the caller.
        const wait = retryAfter(res.headers, data, this.now()) ?? 5;
        if (wait <= MAX_WAIT_S && attempt <= 2) {
          await this.sleep(wait * 1000);
          continue;
        }
        throw new ApiError(`429: AroFlo rate limit hit. Retry in ${wait} s.`, 429);
      }
      if (!write && res.status >= 500 && res.status !== 501 && attempt <= 2) {
        await this.sleep(400 * 2 ** attempt);
        continue;
      }
      if (res.ok) return { status: res.status, data };
      throw this.toError(res.status, data, text, write, opts.collection === true);
    }
  }

  private toError(status: number, data: unknown, text: string, write: boolean, collection: boolean): ApiError {
    const raw = isObj(data) ? (data.error ?? data.message ?? data.detail) : undefined;
    const msg = this.scrub(typeof raw === 'string' ? raw : isObj(raw) || Array.isArray(raw) ? JSON.stringify(raw) : text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    switch (status) {
      case 401:
        return new ApiError(`401: AroFlo rejected the token${msg ? ` (${msg})` : ''}. It may have been revoked or rotated: get a new token and update the MCP config.`, status);
      case 403:
        return new ApiError(`403: ${msg || 'forbidden'}. The token's AroFlo user lacks permission or business-unit access for this.`, status);
      case 404:
        return new ApiError(`404: ${msg || 'not found'}.${collection ? ' A 404 on a list endpoint usually means the token was revoked or rotated.' : ''}`, status);
      default:
        if (write && status >= 500) return new ApiError(`${status}: ${msg || 'server error'}. ${UNKNOWN_HINT}`, status, 'unknown');
        return new ApiError(`${status}: ${msg || 'request failed'}`, status);
    }
  }

  /** Serialised so concurrent callers queue for tokens instead of all waking at once. */
  private pace(): Promise<void> {
    const turn = this.gate.then(() => this.acquire());
    this.gate = turn.catch(() => undefined);
    return turn;
  }

  /** Token bucket (burst 10, refill maxRpm per minute), plus AroFlo's own window counters. */
  private async acquire(): Promise<void> {
    let now = this.now();
    if (this.rate.dailyRemaining !== undefined && this.rate.dailyRemaining <= 0) {
      if (this.rate.dailyResetAt !== undefined && now < this.rate.dailyResetAt) {
        throw new ApiError(`AroFlo daily limit reached; it resets in about ${Math.ceil((this.rate.dailyResetAt - now) / 3_600_000)} h.`, 429);
      }
      this.rate.dailyRemaining = undefined;
    }
    if (this.rate.minuteRemaining !== undefined && this.rate.minuteRemaining <= 1 && this.rate.minuteResetAt !== undefined && now < this.rate.minuteResetAt) {
      await this.sleep(Math.min(60_000, this.rate.minuteResetAt - now));
      this.rate.minuteRemaining = undefined;
      now = this.now();
    }
    const perMs = this.cfg.maxRpm / 60_000;
    this.tokens = Math.min(BURST, this.tokens + (now - this.refilledAt) * perMs);
    this.refilledAt = now;
    if (this.tokens < 1) {
      await this.sleep(Math.ceil((1 - this.tokens) / perMs));
      this.tokens = 1;
      this.refilledAt = this.now();
    }
    this.tokens -= 1;
  }

  private readRate(h: Headers): void {
    const num = (name: string) => {
      const v = h.get(name);
      const n = v === null ? NaN : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const now = this.now();
    const minuteReset = num('x-ratelimit-minutelimit-reset');
    const dailyReset = num('x-ratelimit-dailylimit-reset');
    this.rate.minuteRemaining = num('x-ratelimit-minutelimit-remaining') ?? this.rate.minuteRemaining;
    this.rate.dailyRemaining = num('x-ratelimit-dailylimit-remaining') ?? this.rate.dailyRemaining;
    if (minuteReset !== undefined) this.rate.minuteResetAt = now + minuteReset * 1000;
    if (dailyReset !== undefined) this.rate.dailyResetAt = now + dailyReset * 1000;
  }

  private scrub(s: string): string {
    const t = this.cfg.token;
    return t ? s.split(t).join('[token]') : s;
  }

  private log(line: string): void {
    if (this.cfg.debug) process.stderr.write(`aroflo-v2-mcp: ${line}\n`);
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Seconds to wait from retry_after in the body, a Retry-After header (seconds or HTTP date), or the minute reset. */
function retryAfter(h: Headers, data: unknown, now: number): number | undefined {
  const fromBody = isObj(data) ? Number(data.retry_after ?? data.retryAfter) : NaN;
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const header = h.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs > 0) return Math.ceil(secs);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(1, Math.ceil((at - now) / 1000));
  }
  const reset = Number(h.get('x-ratelimit-minutelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : undefined;
}
