import { QUOTE_HEADER_FIELDS, QUOTE_LINE_FIELDS } from '../defaults.js';
import { isObj, record, table, type Obj } from '../format.js';
import { fetchList } from '../list.js';
import { failure } from './job.js';
import { flag, str, type Tool } from './types.js';

/** The money-related keys of a quote's `counts` (the rest are checklist and form tallies). */
const MONEY = ['total', 'tax', 'taxInclusive', 'labour', 'materials', 'markup', 'labourMarkup', 'materialMarkup'];

function lineRow(l: Obj, nested: boolean): Obj {
  const child = l.parentId !== null && l.parentId !== undefined;
  return {
    item: nested && child ? `- ${String(l.item ?? '')}` : l.item,
    partNumber: l.partNumber,
    type: l.type,
    qty: l.quantity,
    uom: l.uom,
    unitSell: l.unitSell,
    lineTotal: l.lineTotal,
    optional: l.isOptional === true ? 'yes' : undefined
  };
}

export const quoteTool: Tool = {
  def: {
    name: 'aroflo_quote',
    description: 'One quote in one call: header, totals, sections (takeoffs) and top-level lines. quote = job number or quote id. lines=true lists every line by section.',
    inputSchema: {
      type: 'object',
      properties: { quote: { type: 'string' }, lines: { type: 'boolean' } },
      required: ['quote'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },

  async run(args, d) {
    const ref = await d.jobs.resolve('quotes', str(args, 'quote'));
    const id = encodeURIComponent(ref.id);
    const lineOp = d.catalog.get('GET /quotes/{quoteId}/lineitems')!;
    const header = await d.http.request('GET', `/quotes/${id}`, { query: { _fields: QUOTE_HEADER_FIELDS }, template: 'GET /quotes/{quoteId}' });
    const [takeoffs] = await Promise.allSettled([fetchList(d.http, d.catalog.get('GET /quotes/{quoteId}/takeoffs')!, `/quotes/${id}/takeoffs`, {}, 100)]);

    const h: Obj = isObj(header.data) ? { ...header.data } : {};
    const counts = isObj(h.counts) ? h.counts : undefined;
    delete h.counts;
    const out = [record(h, { maxText: 300 })];
    if (counts) {
      const money = MONEY.filter((k) => counts[k] !== undefined && counts[k] !== null).map((k) => `${k} ${String(counts[k])}`);
      if (money.length) out.push(`totals: ${money.join(', ')}`);
    }

    const sections =
      takeoffs.status === 'fulfilled'
        ? takeoffs.value.items.filter(isObj).map((t) => ({
            id: t.id,
            name: t.name,
            totalInc: isObj(t.breakdown) ? t.breakdown.totalInc : undefined,
            labourHours: isObj(t.breakdown) ? t.breakdown.totalLabourHours : undefined
          }))
        : [];
    if (takeoffs.status === 'rejected') out.push(failure('sections', takeoffs)!);
    else if (sections.length) out.push(`sections (${sections.length}):\n${table(sections)}`);

    const path = `/quotes/${id}/lineitems`;
    if (flag(args, 'lines') && sections.length) {
      for (const s of sections) {
        const r = await fetchList(d.http, lineOp, path, { takeoffId: String(s.id), _fields: QUOTE_LINE_FIELDS }, 500);
        const rows = r.items.filter(isObj).map((l) => lineRow(l, true));
        out.push(`## ${String(s.name)} (${rows.length}${r.next ? '+' : ''} lines)`, table(rows, { maxCell: 50 }));
      }
      return out.join('\n');
    }

    const all = await fetchList(d.http, lineOp, path, { _fields: QUOTE_LINE_FIELDS }, 500);
    const lines = all.items.filter(isObj);
    const shown = flag(args, 'lines') ? lines : lines.filter((l) => l.parentId === null || l.parentId === undefined);
    const of = all.total ?? lines.length;
    out.push(
      flag(args, 'lines') ? `lines (${shown.length}${all.next ? '+' : ''}):` : `lines: ${shown.length} top-level of ${of}${all.next ? '+' : ''} (lines=true lists all)`,
      table(
        shown.map((l) => lineRow(l, flag(args, 'lines'))),
        { maxCell: 50 }
      )
    );
    return out.join('\n');
  }
};
