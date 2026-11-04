import type { Op } from './catalog.js';
import type { Config } from './config.js';

/**
 * Is this write operation enabled? AROFLO_V2_WRITE_OPS entries are "*", a tag name such as "Notes" or
 * "Quote Line Items" (case-insensitive), or an exact key such as "PATCH /clients/{clientId}".
 */
export function writeAllowed(cfg: Config, op: Op): boolean {
  if (op.m === 'GET') return true;
  return cfg.writeOps.some((entry) => {
    if (entry === '*') return true;
    if (entry.toUpperCase().startsWith(`${op.m} `)) return entry.replace(/\s+/g, ' ') === op.k;
    return op.tags.some((t) => t.toLowerCase() === entry.toLowerCase());
  });
}
