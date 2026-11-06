import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  token?: string;
  /** Why no token is available, shown on the first tool call instead of failing at startup. */
  tokenError?: string;
  baseUrl: string;
  /**
   * Write operations the server may send, each only after the user confirms it: "*" (all, the default), a tag
   * such as "Notes", or an exact "PATCH /clients/{clientId}". Empty means read-only.
   */
  writeOps: string[];
  businessUnitId?: string;
  maxRpm: number;
  timeoutMs: number;
  auditLog: string;
  defaultLimit: number;
  debug: boolean;
}

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = (m) => process.stderr.write(`aroflo-v2-mcp: ${m}\n`)): Config {
  let token = env.AROFLO_V2_API_KEY?.trim() || undefined;
  let tokenError: string | undefined;
  const tokenFile = env.AROFLO_V2_TOKEN_FILE?.trim();
  if (!token && tokenFile) {
    const path = expandHome(tokenFile);
    try {
      if (statSync(path).mode & 0o077) warn(`${path} is readable by other users; run chmod 600 on it`);
      token = readFileSync(path, 'utf8').trim() || undefined;
      if (!token) tokenError = `AROFLO_V2_TOKEN_FILE ${path} is empty`;
    } catch (err) {
      tokenError = `cannot read AROFLO_V2_TOKEN_FILE ${path}: ${(err as Error).message}`;
    }
  }
  if (!token && !tokenError) tokenError = 'no AroFlo token: set AROFLO_V2_API_KEY or AROFLO_V2_TOKEN_FILE in the MCP server config';

  let baseUrl = (env.AROFLO_V2_BASE_URL?.trim() || 'https://api.aroflo.com/v2').replace(/\/+$/, '');
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(baseUrl);
  if (!baseUrl.startsWith('https://') && !local) {
    warn(`ignoring AROFLO_V2_BASE_URL=${baseUrl}: the token is only sent over https`);
    baseUrl = 'https://api.aroflo.com/v2';
  }

  // Writes are on by default; each one still needs the user's OK. AROFLO_V2_READ_ONLY turns them off, and any
  // value other than empty, 0, false, no or off counts, so a typo lands on read-only. AROFLO_V2_WRITE_OPS limits
  // them to a list; set but empty also means no writes, which is what it meant before writes were on by default.
  const readOnly = !['', '0', 'false', 'no', 'off'].includes((env.AROFLO_V2_READ_ONLY ?? '').trim().toLowerCase());
  const listed = env.AROFLO_V2_WRITE_OPS;
  if (readOnly && listed?.trim()) warn('ignoring AROFLO_V2_WRITE_OPS: AROFLO_V2_READ_ONLY is set, so writes are off');
  const writeOps = readOnly
    ? []
    : listed === undefined
      ? ['*']
      : listed
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  return {
    token,
    tokenError: token ? undefined : tokenError,
    baseUrl,
    writeOps,
    businessUnitId: env.AROFLO_V2_BUSINESS_UNIT_ID?.trim() || undefined,
    maxRpm: int(env.AROFLO_V2_MAX_RPM, 60, 1, 120),
    timeoutMs: int(env.AROFLO_V2_TIMEOUT_MS, 30_000, 1_000, 120_000),
    auditLog: expandHome(env.AROFLO_V2_AUDIT_LOG?.trim() || '~/.local/state/aroflo-v2-mcp/audit.jsonl'),
    defaultLimit: int(env.AROFLO_V2_DEFAULT_LIMIT, 25, 1, 100),
    debug: env.AROFLO_V2_DEBUG === '1'
  };
}
