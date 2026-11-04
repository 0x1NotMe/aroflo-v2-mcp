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
}

const PAGE = 100;
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
  async resolve(kind: Kind, ref: string): Promise<JobRef> {
    const s = ref.trim().replace(/^#/, '');
    if (/^\d{1,9}$/.test(s)) {
      const hit = await this.find(kind, Number(s));
      if (!hit) throw new UsageError(`No ${NOUN[kind]} with job number ${s}.`);
      return hit;
    }
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(s)) throw new UsageError(`"${ref}" is neither a job number nor an AroFlo id.`);
    return { id: s };
  }

  async find(kind: Kind, jobNumber: number): Promise<JobRef | undefined> {
    const cache = this.seen[kind];
    const hit = () => cache.get(jobNumber);
    if (hit()) return hit();
    const sorted = kind === 'tasks';

    const first = await this.page(kind, 1);
    if (hit()) return hit();
    const pages = first.pages;
    if (pages <= 1) return undefined;
    const last = await this.page(kind, pages);
    if (hit()) return hit();
    if (sorted && (jobNumber < first.min || jobNumber > last.max)) return undefined;

    let lo = 1;
    let hi = pages;
    let loMax = first.max;
    let hiMin = last.min;
    let probe = jobNumber - first.max < last.min - jobNumber ? 1 : pages;
    for (let i = 0; i < 14 && hi - lo > 1; i++) {
      const frac = hiMin > loMax ? (jobNumber - loMax) / (hiMin - loMax) : 0.5;
      probe = Math.min(hi - 1, Math.max(lo + 1, lo + 1 + Math.floor(frac * (hi - lo - 1))));
      const p = await this.page(kind, probe);
      if (hit()) return hit();
      if (jobNumber < p.min) {
        hi = probe;
        hiMin = p.min;
      } else if (jobNumber > p.max) {
        lo = probe;
        loMax = p.max;
      } else break; // inside this page's range but not on it
    }

    // The list can be locally out of order: look next door before giving up.
    for (const n of [probe - 1, probe + 1, probe - 2, probe + 2]) {
      if (n < 1 || n > pages || this.fetched[kind].has(n)) continue;
      await this.page(kind, n);
      if (hit()) return hit();
    }
    if (sorted) return undefined;
    for (let n = 1; n <= pages; n++) {
      if (this.fetched[kind].has(n)) continue;
      await this.page(kind, n);
      if (hit()) return hit();
    }
    return undefined;
  }

  private async page(kind: Kind, n: number): Promise<Page> {
    const known = this.fetched[kind].get(n);
    if (known) return known;
    const query: Record<string, string> = { _fields: 'id,jobNumber,name', page: String(n), limit: String(PAGE) };
    if (kind === 'tasks') Object.assign(query, { sortBy: 'jobnumber', ascending: 'true' });
    const res = await this.http.request('GET', `/${kind}`, { query, collection: true, template: `GET /${kind}` });
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
    const page = { min, max, pages };
    this.fetched[kind].set(n, page);
    return page;
  }
}
