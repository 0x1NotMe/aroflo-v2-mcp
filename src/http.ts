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
  minuteReset?: number;
  dailyRemaining?: number;
  dailyReset?: number;
}

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  /** The path is a collection (no ids): a 404 there points at a revoked token, not a missing record. */
  collection?: boolean;
  /** Template used in debug logs instead of the concrete path. */
  template?: string;
}

export interface ApiResponse {
  status: number;
  data: unknown;
}

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

const BURST = 10;
const UNKNOWN_HINT = 'The write may or may not have been applied: check with aroflo_get before retrying.';

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AroFloHttp {
  readonly rate: RateState = {};
  private tokens = BURST;
  private refilledAt = Date.now();

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
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const write = method !== 'GET';
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
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs)
        });
      } catch (err) {
        const reason = this.scrub(err instanceof Error ? (err.name === 'TimeoutError' ? `timed out after ${this.cfg.timeoutMs} ms` : err.message) : String(err));
        if (!write && attempt <= 2) {
          await this.sleep(400 * 2 ** attempt);
          continue;
        }
        throw write
          ? new ApiError(`No response from AroFlo (${reason}). ${UNKNOWN_HINT}`, 0, 'unknown')
          : new ApiError(`AroFlo request failed: ${reason}`, 0);
      }
      this.readRate(res.headers);
      const text = await res.text();
      const data = parseJson(text);
      this.log(`${method} ${opts.template ?? path} ${res.status} ${this.now() - started}ms`);

      // A 429 is rejected before processing, so even a write is safe to send again.
      if (res.status === 429 && attempt <= 2) {
        await this.sleep(Math.min(30, retryAfter(res.headers, data) ?? 5) * 1000);
        continue;
      }
      if (!write && res.status >= 500 && res.status !== 501 && attempt <= 2) {
        await this.sleep(400 * 2 ** attempt);
        continue;
      }
      if (res.ok) return { status: res.status, data };
      throw this.toError(res.status, data, text, write, opts.collection === true, res.headers);
    }
  }

  private toError(status: number, data: unknown, text: string, write: boolean, collection: boolean, headers: Headers): ApiError {
    const raw = isObj(data) ? (data.error ?? data.message ?? data.detail) : undefined;
    const msg = this.scrub(typeof raw === 'string' ? raw : isObj(raw) || Array.isArray(raw) ? JSON.stringify(raw) : text).replace(/\s+/g, ' ').trim().slice(0, 400);
    switch (status) {
      case 401:
        return new ApiError(`401: AroFlo rejected the token${msg ? ` (${msg})` : ''}. It may have been revoked or rotated: get a new token and update the MCP config.`, status);
      case 403:
        return new ApiError(`403: ${msg || 'forbidden'}. The token's AroFlo user lacks permission or business-unit access for this.`, status);
      case 404:
        return new ApiError(
          `404: ${msg || 'not found'}.${collection ? ' A 404 on a list endpoint usually means the token was revoked or rotated.' : ''}`,
          status
        );
      case 429:
        return new ApiError(`429: AroFlo rate limit hit. Retry in ${retryAfter(headers, data) ?? 60} s.`, status);
      default:
        if (write && status >= 500) return new ApiError(`${status}: ${msg || 'server error'}. ${UNKNOWN_HINT}`, status, 'unknown');
        return new ApiError(`${status}: ${msg || 'request failed'}`, status);
    }
  }

  /** Token bucket (burst 10, refill maxRpm per minute) plus a stop when AroFlo says the window is spent. */
  private async pace(): Promise<void> {
    if (this.rate.dailyRemaining !== undefined && this.rate.dailyRemaining <= 0) {
      const hours = this.rate.dailyReset ? Math.ceil(this.rate.dailyReset / 3600) : 24;
      throw new ApiError(`AroFlo daily limit reached; it resets in about ${hours} h.`, 429);
    }
    if (this.rate.minuteRemaining !== undefined && this.rate.minuteRemaining <= 1 && this.rate.minuteReset) {
      await this.sleep(Math.min(60, this.rate.minuteReset) * 1000);
      this.rate.minuteRemaining = undefined;
    }
    const perMs = this.cfg.maxRpm / 60_000;
    const now = this.now();
    this.tokens = Math.min(BURST, this.tokens + (now - this.refilledAt) * perMs);
    this.refilledAt = now;
    if (this.tokens < 1) {
      const wait = Math.ceil((1 - this.tokens) / perMs);
      await this.sleep(wait);
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
    this.rate.minuteRemaining = num('x-ratelimit-minutelimit-remaining') ?? this.rate.minuteRemaining;
    this.rate.minuteReset = num('x-ratelimit-minutelimit-reset') ?? this.rate.minuteReset;
    this.rate.dailyRemaining = num('x-ratelimit-dailylimit-remaining') ?? this.rate.dailyRemaining;
    this.rate.dailyReset = num('x-ratelimit-dailylimit-reset') ?? this.rate.dailyReset;
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

function retryAfter(h: Headers, data: unknown): number | undefined {
  const fromBody = isObj(data) ? Number(data.retry_after ?? data.retryAfter) : NaN;
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const header = Number(h.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  const reset = Number(h.get('x-ratelimit-minutelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : undefined;
}
