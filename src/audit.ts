import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isObj } from './format.js';

export interface AuditEntry {
  ts: string;
  op: string;
  path: string;
  status: number;
  outcome: 'ok' | 'failed' | 'unknown';
  bodySha256?: string;
  ids?: string[];
}

/** Ids from a write response (top-level id, *Id fields, items[].id), for the audit trail. No other content. */
export function idsIn(data: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 3 || out.length >= 20) return out;
  if (Array.isArray(data)) for (const x of data) idsIn(x, out, depth + 1);
  else if (isObj(data)) {
    for (const [k, v] of Object.entries(data)) {
      if ((k === 'id' || k.endsWith('Id') || k === 'ids') && (typeof v === 'string' || typeof v === 'number')) out.push(String(v));
      else if (k === 'ids' && Array.isArray(v)) v.forEach((x) => (typeof x === 'string' || typeof x === 'number') && out.push(String(x)));
      else if (typeof v === 'object' && k !== '_links') idsIn(v, out, depth + 1);
    }
  }
  return [...new Set(out)].slice(0, 20);
}

/** Append one JSON line to the audit log (dir 700, file 600). Returns an error message instead of throwing. */
export function audit(file: string, entry: AuditEntry): string | undefined {
  if (file === '/dev/null') return undefined;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return undefined;
  } catch (err) {
    return `audit log write failed: ${(err as Error).message}`;
  }
}
