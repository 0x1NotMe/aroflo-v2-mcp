import { DEFAULT_FIELDS } from '../defaults.js';
import { isObj, render, table } from '../format.js';
import { fetchList, type ListResult, MAX_ROWS } from '../list.js';
import { buildQuery, fieldNames, resolveTarget, UsageError } from '../request.js';
import { flag, str, type Tool } from './types.js';

function count(raw: string, name: string, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`${name} must be a whole number from 1 to ${max}.`);
  return n;
}

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
      'Read AroFlo data by API path plus query, e.g. /clients?name.like=smith, /tasks?status=1&sortBy=requiredby, /tasks/{id}/labours, /schedules?scheduleZone=USER&currentDate=2026-11-05. Lists return 25 rows (limit=N up to 500, page=N). _fields=a,b picks columns. Business-unit ids fill themselves. Unsure of a path or filter: aroflo_api.',
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
    const pageable = op.q.some((p) => p.n === 'page') && op.q.some((p) => p.n === 'limit');

    let want = d.cfg.defaultLimit;
    let startPage: number | undefined;
    if (op.list && pageable) {
      const limit = search.get('limit');
      const page = search.get('page');
      if (limit !== null) want = count(limit, 'limit', page !== null ? 100 : MAX_ROWS);
      if (page !== null) startPage = count(page, 'page', 1_000_000);
      search.delete('limit');
      search.delete('page');
    }
    // Default columns: sent as _fields where AroFlo supports it, otherwise applied to the rows here.
    // Either way the model only reads the columns that matter.
    const defaults = !full && !search.has('_fields') ? DEFAULT_FIELDS[op.k] : undefined;
    const serverSide = op.q.some((p) => p.n === '_fields');
    if (defaults && serverSide) search.set('_fields', defaults);
    const query = await buildQuery(op, search, d.ctx);
    const maxCell = full ? 4_000 : 60;

    if (op.list) {
      const r = await fetchList(d.http, op, target.path, query, want, startPage);
      const columns = query._fields ? fieldNames(query._fields) : defaults ? fieldNames(defaults) : undefined;
      const rows = defaults && !serverSide ? r.items.map((row) => (isObj(row) ? Object.fromEntries(columns!.filter((c) => c in row).map((c) => [c, row[c]])) : row)) : r.items;
      const body = table(rows, { columns, maxCell });
      return body ? `${listHeader(r)}\n${body}` : listHeader(r);
    }
    const res = await d.http.request('GET', target.path, { query, collection: op.pp.length === 0, template: op.k });
    return render(res.data, { maxText: full ? 100_000 : 600, maxCell, full }) || '(empty response)';
  }
};
