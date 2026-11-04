import { JOB_FIELDS, JOB_LABOUR_FIELDS, JOB_MATERIAL_FIELDS } from '../defaults.js';
import { cut, isObj, label, plainText, record, shortDate, table, type Obj } from '../format.js';
import { fetchList } from '../list.js';
import { num, round, str, type Tool } from './types.js';

const MAX_NOTES = 5;

export function itemsOf(data: unknown): Obj[] {
  const rows = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.items) ? data.items : isObj(data) ? [data] : [];
  return rows.filter(isObj);
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
    description: 'One job (task) in one call: details, labour hours by person and work type, materials and latest notes. job = job number or task id.',
    inputSchema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },

  async run(args, d) {
    const ref = await d.jobs.resolve('tasks', str(args, 'job'));
    const id = encodeURIComponent(ref.id);
    const task = await d.http.request('GET', `/tasks/${id}`, { query: { _fields: JOB_FIELDS }, template: 'GET /tasks/{taskId}' });
    const bu = await d.ctx.businessUnitId();
    const [labour, materials, notes] = await Promise.allSettled([
      fetchList(d.http, d.catalog.get('GET /tasks/{taskId}/labours')!, `/tasks/${id}/labours`, { _fields: JOB_LABOUR_FIELDS }, 500),
      d.http.request('GET', `/tasks/${id}/materials`, { query: { businessUnitId: bu, _fields: JOB_MATERIAL_FIELDS }, template: 'GET /tasks/{taskId}/materials' }),
      d.http.request('GET', `/tasks/${id}/notes`, { query: { _fields: 'note,timestampCreated' }, template: 'GET /tasks/{task_id}/notes' })
    ]);

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
      out.push(rows.length ? `materials (${rows.length}):\n${table(rows, { maxCell: 50 })}` : 'materials: none');
    } else out.push(failure('materials', materials)!);

    if (notes.status === 'fulfilled') {
      const rows = itemsOf(notes.value.data).filter((n) => typeof n.note === 'string' && n.note.trim());
      rows.sort((a, b) => String(b.timestampCreated ?? '').localeCompare(String(a.timestampCreated ?? '')));
      if (rows.length) {
        out.push(`notes (latest ${Math.min(MAX_NOTES, rows.length)} of ${rows.length}):`);
        for (const n of rows.slice(0, MAX_NOTES)) {
          const when = typeof n.timestampCreated === 'string' ? `${shortDate(n.timestampCreated)}: ` : '';
          out.push(`${when}${cut(plainText(String(n.note)), 240)}`);
        }
      } else out.push('notes: none');
    } else out.push(failure('notes', notes)!);

    return out.join('\n');
  }
};
