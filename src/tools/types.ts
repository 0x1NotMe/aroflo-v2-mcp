import type { ApiCatalog } from '../catalog.js';
import type { Config } from '../config.js';
import type { SessionContext } from '../context.js';
import type { AroFloHttp } from '../http.js';
import type { JobIndex } from '../jobs.js';
import { UsageError } from '../request.js';

export interface Deps {
  cfg: Config;
  catalog: ApiCatalog;
  http: AroFloHttp;
  ctx: SessionContext;
  jobs: JobIndex;
  /** Ask the user to approve, outside the model (MCP elicitation). Present only when the client supports it. */
  askUser?: (message: string) => Promise<boolean>;
  /** Cancellation of the current tool call, from the MCP client. */
  signal?: AbortSignal;
}

/** What tools/list sends. Keep descriptions and schemas short: every client pays for them on every turn. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties?: false;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface Tool {
  def: ToolDef;
  run(args: Record<string, unknown>, deps: Deps): Promise<string>;
}

export function str(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string' || !v.trim()) throw new UsageError(`${name} is required.`);
  return v.trim();
}

/** Optional boolean argument. Accepts true/false, 1/0, yes/no (any case); anything else is an error, not a silent false. */
export function flag(args: Record<string, unknown>, name: string): boolean {
  const v = args[name];
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no', ''].includes(s)) return false;
  throw new UsageError(`${name} must be true or false.`);
}

export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
