import type { Op } from './catalog.js';
import { isObj } from './format.js';
import type { AroFloHttp } from './http.js';

export const MAX_ROWS = 500;
const PAGE_MAX = 100;

export interface ListResult {
  items: unknown[];
  /** Total across all pages, when AroFlo reports it. */
  total?: number;
  /** Query that returns the rows right after these, when more exist. */
  next?: { page: number; limit: number };
}

interface Page {
  items: unknown[];
  total?: number;
  pages?: number;
}

function readPage(data: unknown): Page {
  if (Array.isArray(data)) return { items: data };
  if (!isObj(data)) return { items: [] };
  const items = Array.isArray(data.items) ? data.items : [];
  const page = isObj(data.page) ? data.page : undefined;
  // `count` is the grand total only when a `page` object is present (/bills reports rows returned).
  const total = page && typeof data.count === 'number' ? data.count : undefined;
  const pages = page && typeof page.count === 'number' ? page.count : undefined;
  return { items, total, pages };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Fetch up to `want` rows (max 500). With `startPage`, fetch exactly that page at `want` rows per page
 * (max 100). Without it, page through from page 1 and stop as soon as `want` rows are in hand.
 */
export async function fetchList(http: AroFloHttp, op: Op, path: string, query: Record<string, string>, want: number, startPage?: number, signal?: AbortSignal): Promise<ListResult> {
  want = Math.min(Math.max(1, Math.floor(want) || 1), MAX_ROWS);
  const pageable = op.q.some((p) => p.n === 'page') && op.q.some((p) => p.n === 'limit');
  const request = (q: Record<string, string>) => http.request('GET', path, { query: q, collection: op.pp.length === 0, template: op.k, signal });

  if (!pageable) {
    const page = readPage((await request(query)).data);
    return { items: page.items.slice(0, want), total: page.total ?? page.items.length };
  }

  if (startPage !== undefined) {
    const limit = Math.min(Math.max(1, want), PAGE_MAX);
    const page = readPage((await request({ ...query, page: String(startPage), limit: String(limit) })).data);
    const more = page.pages !== undefined ? startPage < page.pages : page.items.length === limit;
    return { items: page.items, total: page.total, next: more ? { page: startPage + 1, limit } : undefined };
  }

  const target = Math.min(Math.max(1, want), MAX_ROWS);
  const pageSize = Math.min(target, PAGE_MAX);
  const items: unknown[] = [];
  let total: number | undefined;
  for (let pageNo = 1; ; pageNo++) {
    const page = readPage((await request({ ...query, page: String(pageNo), limit: String(pageSize) })).data);
    items.push(...page.items);
    total = page.total ?? total;
    const more = page.pages !== undefined ? pageNo < page.pages : page.items.length === pageSize;
    if (items.length >= target) {
      const moreRows = items.length > target || more;
      // The next chunk starts at row target+1: pick a page size that divides target so a plain page/limit reaches it.
      const step = target <= PAGE_MAX ? pageSize : gcd(target, PAGE_MAX);
      return { items: items.slice(0, target), total, next: moreRows ? { page: target / step + 1, limit: step } : undefined };
    }
    if (!more || page.items.length === 0) return { items, total: total ?? items.length };
  }
}
