import { QUOTE_HEADER_FIELDS, QUOTE_LINE_FIELDS } from '../defaults.js';
import { isObj, record, table, type Obj } from '../format.js';
import { fetchList } from '../list.js';
import { failure, rethrowAuth } from './job.js';
import { flag, num, round, str, type Tool } from './types.js';

/** The money-related keys of a quote's `counts` (the rest are checklist and form tallies). `labour` is money, not hours. */
const MONEY = ['total', 'tax', 'taxInclusive', 'labour', 'materials', 'markup', 'labourMarkup', 'materialMarkup'];
/** lines=true fetches one section at a time; past this many sections, point at aroflo_get instead. */
const MAX_SECTIONS = 30;

function lineRow(l: Obj, nested: boolean): Obj {
  const child = l.parentId !== null && l.parentId !== undefined;
  // labourQuantity is labour hours per unit. On a top-level line, times quantity, it is the line's hours,
  // and those add up to the sections' totalLabourHours (checked on a live quote). A component's quantity
  // is per unit of its assembly, so the same product is not hours on the quote: component rows show none.
  const hours = child ? 0 : num(l.labourQuantity) * num(l.quantity);
  return {
    item: nested && child ? `- ${String(l.item ?? '')}` : l.item,
    partNumber: l.partNumber,
    type: l.type,
    qty: l.quantity,
    uom: l.uom,
    unitSell: l.unitSell,
    lineTotal: l.lineTotal,
    labourHours: hours ? round(hours) : undefined,
    optional: l.isOptional === true ? 'yes' : undefined
  };
}

export const quoteTool: Tool = {
  def: {
    name: 'aroflo_quote',
    description: 'One quote in one call: header, totals, labour hours, sections (takeoffs) and top-level lines. quote = job number or quote id. lines=true lists every line by section.',
    inputSchema: {
      type: 'object',
      properties: { quote: { type: 'string' }, lines: { type: 'boolean' } },
      required: ['quote'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },

  async run(args, d) {
    const ref = await d.jobs.resolve('quotes', str(args, 'quote'), d.signal);
    const id = encodeURIComponent(ref.id);
    const lineOp = d.catalog.get('GET /quotes/{quoteId}/lineitems')!;
    const header = await d.http.request('GET', `/quotes/${id}`, { query: { _fields: QUOTE_HEADER_FIELDS }, template: 'GET /quotes/{quoteId}', signal: d.signal });
    const [takeoffs] = await Promise.allSettled([fetchList(d.http, d.catalog.get('GET /quotes/{quoteId}/takeoffs')!, `/quotes/${id}/takeoffs`, {}, 500, undefined, d.signal)]);
    rethrowAuth([takeoffs]);

    const h: Obj = isObj(header.data) ? { ...header.data } : {};
    const counts = isObj(h.counts) ? h.counts : undefined;
    delete h.counts;
    const sections =
      takeoffs.status === 'fulfilled'
        ? takeoffs.value.items.filter(isObj).map((t) => ({
            id: t.id,
            name: t.name,
            totalInc: isObj(t.breakdown) ? t.breakdown.totalInc : undefined,
            labourHours: isObj(t.breakdown) ? t.breakdown.totalLabourHours : undefined
          }))
        : [];

    const out = [record(h, { maxText: 300 })];
    if (counts) {
      const money = MONEY.filter((k) => counts[k] !== undefined && counts[k] !== null).map((k) => `${k} ${String(counts[k])}`);
      if (money.length) out.push(`totals: ${money.join(', ')}`);
    }
    // The quote's labour hours are AroFlo's per-section figures added up; the header has no hours total.
    const timed = sections.filter((s) => s.labourHours !== undefined && s.labourHours !== null);
    if (timed.length) {
      const more = takeoffs.status === 'fulfilled' && takeoffs.value.next ? '+' : '';
      out.push(`labour hours: ${round(timed.reduce((sum, s) => sum + num(s.labourHours), 0))}${more}`);
    }

    if (takeoffs.status === 'rejected') out.push(failure('sections', takeoffs)!);
    else if (sections.length) out.push(`sections (${sections.length}${takeoffs.value.next ? '+' : ''}):\n${table(sections)}`);

    const path = `/quotes/${id}/lineitems`;
    if (flag(args, 'lines') && sections.length) {
      for (const s of sections.slice(0, MAX_SECTIONS)) {
        const r = await fetchList(d.http, lineOp, path, { takeoffId: String(s.id), _fields: QUOTE_LINE_FIELDS }, 500, undefined, d.signal);
        const rows = r.items.filter(isObj).map((l) => lineRow(l, true));
        out.push(`## ${String(s.name)} (${rows.length}${r.next ? '+' : ''} lines)`, table(rows, { maxCell: 50 }));
      }
      if (sections.length > MAX_SECTIONS) out.push(`… ${sections.length - MAX_SECTIONS} more sections: aroflo_get /quotes/${ref.id}/lineitems?takeoffId=<section id>`);
      return out.join('\n');
    }

    const all = await fetchList(d.http, lineOp, path, { _fields: QUOTE_LINE_FIELDS }, 500, undefined, d.signal);
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
