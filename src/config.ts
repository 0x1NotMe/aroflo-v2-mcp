import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  token?: string;
  /** Why no token is available, shown on the first tool call instead of failing at startup. */
  tokenError?: string;
  baseUrl: string;
  /** AROFLO_V2_WRITE_OPS entries: "*", a tag such as "Notes", or an exact "PATCH /clients/{clientId}". */
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

  return {
    token,
    tokenError: token ? undefined : tokenError,
    baseUrl,
    writeOps: (env.AROFLO_V2_WRITE_OPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    businessUnitId: env.AROFLO_V2_BUSINESS_UNIT_ID?.trim() || undefined,
    maxRpm: int(env.AROFLO_V2_MAX_RPM, 60, 1, 120),
    timeoutMs: int(env.AROFLO_V2_TIMEOUT_MS, 30_000, 1_000, 120_000),
    auditLog: expandHome(env.AROFLO_V2_AUDIT_LOG?.trim() || '~/.local/state/aroflo-v2-mcp/audit.jsonl'),
    defaultLimit: int(env.AROFLO_V2_DEFAULT_LIMIT, 25, 1, 100),
    debug: env.AROFLO_V2_DEBUG === '1'
  };
}
