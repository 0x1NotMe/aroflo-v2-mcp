import { DEFAULT_FIELDS, HINTS } from '../defaults.js';
import { isObj, render, table } from '../format.js';
import { fetchList, type ListResult, MAX_ROWS, PAGE_MAX, pageable } from '../list.js';
import { buildQuery, fieldNames, resolveTarget, UsageError } from '../request.js';
import { flag, str, type Tool } from './types.js';

function count(raw: string, name: string, max: number, more = ''): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`${name} must be a whole number from 1 to ${max}.${more}`);
  return n;
}

const PAGED_LIMIT = ` With page=N, limit is rows per page and AroFlo allows at most ${PAGE_MAX}. Leave out page to get up to ${MAX_ROWS} rows in one call.`;
const MORE_ROWS = ' For more rows, call again with the page and limit after "next:" in the first line of the result.';

export function listHeader(r: ListResult): string {
  const shown = r.items.length;
  const of = r.total !== undefined && r.total !== shown ? ` of ${r.total}` : '';
  const next = r.next ? `; next: page=${r.next.page}&limit=${r.next.limit}` : '';
  return `${shown}${of} ${shown === 1 && !of ? 'row' : 'rows'}${next}`;
}

export const getTool: Tool = {
  def: {
    name: 'aroflo_get',
    description:
      'Read AroFlo data by API path plus query, e.g. /clients?name.like=smith, /tasks?status=1&serviceId=<task type id from /types/tasks>, /tasks/{id}/labours, /schedules?scheduleZone=USER&currentDate=2026-11-05. Lists return 25 rows (limit=N up to 500, or page=N with limit up to 100). _fields=a,b picks columns. Business-unit ids fill themselves. Unsure of a path or filter: aroflo_api.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        full: { type: 'boolean', description: 'All columns, no text cuts' }
      },
      required: ['path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },

  async run(args, d) {
    const full = flag(args, 'full');
    const target = await resolveTarget(d.catalog, 'GET', str(args, 'path'), d.ctx);
    const { op, search } = target;
    const paged = pageable(op);

    // limit is always ours (rows to show). page goes to AroFlo only where the endpoint pages.
    let want = d.cfg.defaultLimit;
    let startPage: number | undefined;
    const limit = search.get('limit');
    const page = paged ? search.get('page') : null;
    if (limit !== null) want = page !== null ? count(limit, 'limit', PAGE_MAX, PAGED_LIMIT) : count(limit, 'limit', MAX_ROWS, MORE_ROWS);
    if (page !== null) startPage = count(page, 'page', 1_000_000);
    search.delete('limit');
    if (paged) search.delete('page');
    // Default columns: sent as _fields where AroFlo supports it, otherwise applied to the rows here.
    // Either way the model only reads the columns that matter.
    const defaults = !full && !search.has('_fields') ? DEFAULT_FIELDS[op.k] : undefined;
    const serverSide = op.q.some((p) => p.n === '_fields');
    if (defaults && serverSide) search.set('_fields', defaults);
    const query = await buildQuery(op, search, d.ctx);
    const maxCell = full ? 4_000 : 60;

    // Anything AroFlo pages is a list, whatever the spec says its response looks like.
    if (op.list || paged) {
      const r = await fetchList(d.http, op, target.path, query, want, startPage, d.signal);
      const columns = query._fields ? fieldNames(query._fields) : defaults ? fieldNames(defaults) : undefined;
      const rows = defaults && !serverSide ? r.items.map((row) => (isObj(row) ? Object.fromEntries(columns!.filter((c) => c in row).map((c) => [c, row[c]])) : row)) : r.items;
      const body = table(rows, { columns, maxCell });
      const hints = (HINTS[op.k] ?? [])
        .filter((h) => (h.param !== undefined && h.param in query) || (h.absent !== undefined && !(h.absent in query)))
        .map((h) => `hint: ${h.text}`);
      return [listHeader(r), body, ...hints].filter(Boolean).join('\n');
    }
    const res = await d.http.request('GET', target.path, { query, collection: op.pp.length === 0, template: op.k, signal: d.signal });
    // Some endpoints the spec calls single records answer with a list: bound those like any list.
    const envelope = (o: Record<string, unknown>) => Array.isArray(o.items) && Object.keys(o).every((k) => ['items', 'count', 'page', '_links'].includes(k));
    const rows = Array.isArray(res.data) ? res.data : isObj(res.data) && envelope(res.data) ? (res.data.items as unknown[]) : undefined;
    if (rows) {
      const shown = rows.slice(0, want);
      const head = shown.length < rows.length ? `${shown.length} of ${rows.length} rows (limit=N for more)` : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
      const body = table(shown, { maxCell });
      return body ? `${head}\n${body}` : head;
    }
    return render(res.data, { maxText: full ? 100_000 : 600, maxCell, full }) || '(empty response)';
  }
};
