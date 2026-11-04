import { JOB_FIELDS, JOB_LABOUR_FIELDS, JOB_MATERIAL_FIELDS } from '../defaults.js';
import { cut, isObj, label, plainText, record, shortDate, table, type Obj } from '../format.js';
import { ApiError } from '../http.js';
import { fetchList } from '../list.js';
import { num, round, str, type Tool } from './types.js';

const MAX_NOTES = 5;
const MAX_MATERIALS = 25;

export function itemsOf(data: unknown): Obj[] {
  const rows = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.items) ? data.items : isObj(data) ? [data] : [];
  return rows.filter(isObj);
}

/** A rejected token stops the whole composite: no further calls on a revoked or rotated token. */
export function rethrowAuth(results: PromiseSettledResult<unknown>[]): void {
  for (const r of results) if (r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 401) throw r.reason;
}

export function failure(what: string, r: PromiseSettledResult<unknown>): string | undefined {
  return r.status === 'rejected' ? `${what}: unavailable (${cut(r.reason instanceof Error ? r.reason.message : String(r.reason), 160)})` : undefined;
}

/** "Tom 30.5, Ann 12" from hours grouped by a nested ref such as user or workType. */
function hoursBy(rows: Obj[], key: string): string {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const v = r[key];
    const name = isObj(v) ? (label(v) ?? (typeof v.id === 'string' ? v.id : '?')) : typeof v === 'string' && v ? v : '?';
    totals.set(name, (totals.get(name) ?? 0) + num(r.hours));
  }
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .map(([k, h]) => `${k} ${round(h)}`)
    .join(', ');
}

export const jobTool: Tool = {
  def: {
    name: 'aroflo_job',
    description: 'One job (task) in one call: details, schedule and assigned staff, labour hours by person and work type, materials, latest notes. job = job number or task id.',
    inputSchema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },

  async run(args, d) {
    const ref = await d.jobs.resolve('tasks', str(args, 'job'), d.signal);
    const id = encodeURIComponent(ref.id);
    const task = await d.http.request('GET', `/tasks/${id}`, { query: { _fields: JOB_FIELDS }, template: 'GET /tasks/{taskId}', signal: d.signal });
    const bu = await d.ctx.businessUnitId();
    const [labour, materials, notes] = await Promise.allSettled([
      fetchList(d.http, d.catalog.get('GET /tasks/{taskId}/labours')!, `/tasks/${id}/labours`, { _fields: JOB_LABOUR_FIELDS }, 500, undefined, d.signal),
      d.http.request('GET', `/tasks/${id}/materials`, { query: { businessUnitId: bu, _fields: JOB_MATERIAL_FIELDS }, template: 'GET /tasks/{taskId}/materials', signal: d.signal }),
      d.http.request('GET', `/tasks/${id}/notes`, { query: { _fields: 'note,timestampCreated' }, template: 'GET /tasks/{task_id}/notes', signal: d.signal })
    ]);

    rethrowAuth([labour, materials, notes]);
    const out = [record(task.data, { maxText: 400 })];

    if (labour.status === 'fulfilled') {
      const rows = labour.value.items.filter(isObj);
      if (rows.length) {
        const hours = round(rows.reduce((s, r) => s + num(r.hours), 0));
        const dates = rows
          .map((r) => (typeof r.date === 'string' ? r.date.slice(0, 10) : ''))
          .filter(Boolean)
          .sort();
        const span = dates.length ? `, ${dates[0]} to ${dates.at(-1)}` : '';
        out.push(`labour: ${hours} h in ${rows.length}${labour.value.next ? '+' : ''} entries${span}`, `by person: ${hoursBy(rows, 'user')}`, `by work type: ${hoursBy(rows, 'workType')}`);
      } else out.push('labour: none');
    } else out.push(failure('labour', labour)!);

    if (materials.status === 'fulfilled') {
      const rows = itemsOf(materials.value.data);
      const more = rows.length > MAX_MATERIALS ? `, first ${MAX_MATERIALS}; all: aroflo_get /tasks/${ref.id}/materials?limit=${rows.length}` : '';
      out.push(rows.length ? `materials (${rows.length}${more}):\n${table(rows.slice(0, MAX_MATERIALS), { maxCell: 50 })}` : 'materials: none');
    } else out.push(failure('materials', materials)!);

    if (notes.status === 'fulfilled') {
      // Documented shape: items[].note = {content, postedBy, ...}; older or simpler shapes put text in note.
      const rows = itemsOf(notes.value.data)
        .map((n) => {
          const note = isObj(n.note) ? n.note : undefined;
          const text = typeof n.note === 'string' ? n.note : typeof note?.content === 'string' ? note.content : '';
          const by = note && isObj(note.postedBy) ? label(note.postedBy) : undefined;
          return { text: plainText(text), by, at: typeof n.timestampCreated === 'string' ? n.timestampCreated : '' };
        })
        .filter((n) => n.text);
      rows.sort((a, b) => b.at.localeCompare(a.at));
      if (rows.length) {
        out.push(`notes (latest ${Math.min(MAX_NOTES, rows.length)} of ${rows.length}):`);
        for (const n of rows.slice(0, MAX_NOTES)) {
          const head = [n.at ? shortDate(n.at) : '', n.by ?? ''].filter(Boolean).join(' ');
          out.push(`${head ? `${head}: ` : ''}${cut(n.text, 240)}`);
        }
      } else out.push('notes: none');
    } else out.push(failure('notes', notes)!);

    return out.join('\n');
  }
};
