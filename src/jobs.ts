import { isObj } from './format.js';
import type { AroFloHttp } from './http.js';
import { UsageError } from './request.js';

export type Kind = 'tasks' | 'quotes';

export interface JobRef {
  id: string;
  jobNumber?: number;
  name?: string;
}

interface Page {
  min: number;
  max: number;
  pages: number;
  at: number;
}

const PAGE = 100;
/** Page boundaries go stale as jobs are added; ids found stay cached. */
const PAGE_TTL_MS = 120_000;
const NOUN: Record<Kind, string> = { tasks: 'job', quotes: 'quote' };

/**
 * Finds a task or quote by job number. AroFlo v2 has no job-number filter, but /tasks sorts by job
 * number on request and /quotes lists in near job-number order (rows sit at most about a page from
 * their sorted place). So: interpolation search over 100-row pages, then the neighbouring pages,
 * and for quotes a full scan as the last resort, so a lookup never wrongly says "not found".
 * Every row seen is cached for the session.
 */
export class JobIndex {
  private readonly seen: Record<Kind, Map<number, JobRef>> = { tasks: new Map(), quotes: new Map() };
  private readonly fetched: Record<Kind, Map<number, Page>> = { tasks: new Map(), quotes: new Map() };

  constructor(private readonly http: AroFloHttp) {}

  /** Accepts a job number ("8664" or "#8664") or an AroFlo id. */
  async resolve(kind: Kind, ref: string, signal?: AbortSignal): Promise<JobRef> {
    const s = ref.trim().replace(/^#/, '');
    if (/^\d{1,9}$/.test(s)) {
      const hit = await this.find(kind, Number(s), signal);
      if (!hit) throw new UsageError(`No ${NOUN[kind]} with job number ${s}.`);
      return hit;
    }
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(s)) throw new UsageError(`"${ref}" is neither a job number nor an AroFlo id.`);
    return { id: s };
  }

  async find(kind: Kind, jobNumber: number, signal?: AbortSignal): Promise<JobRef | undefined> {
    const cache = this.seen[kind];
    const hit = () => cache.get(jobNumber);
    if (hit()) return hit();
    const sorted = kind === 'tasks';

    let first = await this.page(kind, 1, false, signal);
    if (hit()) return hit();
    if (first.pages <= 1) {
      if (first.max >= jobNumber) return undefined;
      first = await this.page(kind, 1, true, signal); // a new job may have arrived since page 1 was cached
      return hit();
    }
    let last = await this.page(kind, first.pages, false, signal);
    if (hit()) return hit();
    if (jobNumber > last.max) {
      // New jobs land at the end: re-read the page count and the last page before saying no.
      first = await this.page(kind, 1, true, signal);
      last = await this.page(kind, first.pages, true, signal);
      if (hit()) return hit();
    }
    const pages = first.pages;
    if (sorted && (jobNumber < first.min || jobNumber > last.max)) return undefined;

    // Interpolation for the first probes (fast on evenly spread numbers), then bisection, which
    // bounds the worst case at about log2(pages) calls however the numbers are spread.
    let lo = 1;
    let hi = pages;
    let loMax = first.max;
    let hiMin = last.min;
    let probe = 1;
    for (let i = 0; hi - lo > 1 && i < 40; i++) {
      if (i < 4 && hiMin > loMax) {
        const frac = (jobNumber - loMax) / (hiMin - loMax);
        probe = Math.min(hi - 1, Math.max(lo + 1, lo + 1 + Math.floor(frac * (hi - lo - 1))));
      } else probe = Math.floor((lo + hi) / 2);
      const p = await this.page(kind, probe, false, signal);
      if (hit()) return hit();
      if (p.min > p.max) return undefined; // empty page: the data shrank under us
      if (jobNumber < p.min) {
        hi = probe;
        hiMin = p.min;
      } else if (jobNumber > p.max) {
        lo = probe;
        loMax = p.max;
      } else break; // inside this page's range but not on it
    }

    // The quote list can be locally out of order: look next door before giving up.
    for (const n of [probe - 1, probe + 1, probe - 2, probe + 2]) {
      if (n < 1 || n > pages || this.fresh(kind, n)) continue;
      await this.page(kind, n, false, signal);
      if (hit()) return hit();
    }
    if (sorted) return undefined;
    for (let n = 1; n <= pages; n++) {
      if (this.fresh(kind, n)) continue;
      await this.page(kind, n, false, signal);
      if (hit()) return hit();
    }
    return undefined;
  }

  private fresh(kind: Kind, n: number): boolean {
    const p = this.fetched[kind].get(n);
    return p !== undefined && Date.now() - p.at < PAGE_TTL_MS;
  }

  private async page(kind: Kind, n: number, refresh = false, signal?: AbortSignal): Promise<Page> {
    const known = this.fetched[kind].get(n);
    if (known && !refresh && this.fresh(kind, n)) return known;
    const query: Record<string, string> = { _fields: 'id,jobNumber,name', page: String(n), limit: String(PAGE) };
    if (kind === 'tasks') Object.assign(query, { sortBy: 'jobnumber', ascending: 'true' });
    const res = await this.http.request('GET', `/${kind}`, { query, collection: true, template: `GET /${kind}`, signal });
    const data = res.data;
    const rows = isObj(data) && Array.isArray(data.items) ? data.items : [];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const r of rows) {
      if (!isObj(r) || typeof r.id !== 'string' || typeof r.jobNumber !== 'number') continue;
      const ref: JobRef = { id: r.id, jobNumber: r.jobNumber };
      if (typeof r.name === 'string') ref.name = r.name;
      this.seen[kind].set(r.jobNumber, ref);
      min = Math.min(min, r.jobNumber);
      max = Math.max(max, r.jobNumber);
    }
    const pages = isObj(data) && isObj(data.page) && typeof data.page.count === 'number' ? data.page.count : 1;
    const page = { min, max, pages, at: Date.now() };
    this.fetched[kind].set(n, page);
    return page;
  }
}
