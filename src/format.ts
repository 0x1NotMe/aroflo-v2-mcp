// Compact text rendering. Everything a tool returns goes through here, so this file decides how many
// tokens a response costs. Lists become tab-separated tables (keys appear once, not per row), records
// become `key: value` lines, and nulls, empty values and `_links` disappear.

export type Obj = Record<string, unknown>;

const DROP = new Set(['_links']);
const LABEL_KEYS = ['name', 'fullName', 'displayName', 'title', 'label', 'description', 'value', 'code'];
const FIRST = ['id', 'jobNumber', 'number', 'name'];

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
}

/** Drop `_links`, nulls and empty values, recursively. */
export function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean).filter((x) => !isEmpty(x));
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP.has(k)) continue;
      const c = clean(x);
      if (!isEmpty(c)) out[k] = c;
    }
    return out;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  return v;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML to plain text (AroFlo notes are HTML), whitespace collapsed. */
export function plainText(s: string): string {
  let t = s;
  if (/<[a-z!/][^>]*>/i.test(t)) {
    t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)\s*>/gi, '\n').replace(/<[^>]+>/g, '');
  }
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      const valid = Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return t
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ');
}

/** 2026-11-04T00:00:00.000Z -> 2026-11-04, 2026-11-04T09:30:00Z -> 2026-11-04 09:30Z. Other strings pass through. */
export function shortDate(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return s;
  const [, d, hh, mm, ss, tz] = m;
  if (hh === '00' && mm === '00' && (!ss || ss === '00') && (!tz || tz === 'Z' || /^[+-]00:?00$/.test(tz))) return d!;
  return `${d} ${hh}:${mm}${ss && ss !== '00' ? `:${ss}` : ''}${tz ?? ''}`;
}

/** Cut to max characters. With `mark`, say how much was left out so the model can ask for more. */
export function cut(s: string, max: number, mark = false): string {
  if (s.length <= max) return s;
  return mark ? `${s.slice(0, max)}… [+${s.length - max} chars]` : `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** Best human label for a nested object such as {id, name} or {givenName, familyName}. */
export function label(o: Obj): string | undefined {
  for (const k of LABEL_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return plainText(v);
    if (typeof v === 'number') return String(v);
  }
  const given = o.givenName ?? o.givenNames ?? o.firstName;
  const family = o.familyName ?? o.surname ?? o.lastName;
  const parts = [given, family].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return parts.length ? parts.join(' ') : undefined;
}

function scalar(v: unknown, max: number, mark = false): string {
  if (typeof v === 'string') return cut(shortDate(plainText(v)), max, mark);
  // toPrecision(12) drops float noise (0.30000000000000004) without rounding real values away.
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  if (typeof v === 'boolean') return String(v);
  return '';
}

/** One table cell. Nested objects collapse to their label (or id), arrays to a short list. */
export function cell(v: unknown, max = 60): string {
  let s: string;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (isObj(x) ? (label(x) ?? (typeof x.id === 'string' ? x.id : '')) : scalar(x, max))).filter(Boolean);
    s = parts.length ? parts.slice(0, 3).join(', ') + (parts.length > 3 ? ` +${parts.length - 3}` : '') : `${v.length} items`;
  } else if (isObj(v)) {
    s =
      label(v) ??
      (typeof v.id === 'string'
        ? v.id
        : Object.entries(v)
            .map(([k, x]) => `${k}=${isObj(x) || Array.isArray(x) ? '…' : scalar(x, 24)}`)
            .join(' '));
  } else s = scalar(v, max);
  return cut(s.replace(/[\t\r\n]+/g, ' '), max);
}

function orderColumns(cols: string[]): string[] {
  const first = FIRST.filter((c) => cols.includes(c));
  return [...first, ...cols.filter((c) => !first.includes(c))];
}

/** Tab-separated table with one header row. Columns with no values are dropped. */
export function table(rows: unknown[], opts: { columns?: string[]; maxCell?: number } = {}): string {
  const clean_ = rows.map((r) => (isObj(r) ? (clean(r) as Obj) : { value: r }));
  let cols: string[];
  if (opts.columns?.length) {
    const known = new Set(clean_.flatMap((r) => Object.keys(r)));
    cols = [...opts.columns.filter((c) => known.has(c)), ...orderColumns([...known].filter((c) => !opts.columns!.includes(c)))];
  } else {
    const seen = new Set<string>();
    for (const r of clean_) for (const k of Object.keys(r)) seen.add(k);
    cols = orderColumns([...seen]);
  }
  if (!cols.length) return '';
  const lines = [cols.join('\t')];
  for (const r of clean_) lines.push(cols.map((c) => (c in r ? cell(r[c], opts.maxCell ?? 60) : '')).join('\t'));
  return lines.join('\n');
}

const NAME_PARTS = new Set(['givenName', 'givenNames', 'firstName', 'familyName', 'surname', 'lastName']);

/** `label [id] k=v` for a small reference object; undefined when it is too big or nested to collapse. */
function refText(o: Obj, max: number): string | undefined {
  const l = label(o);
  if (l === undefined || typeof o.id !== 'string') return undefined;
  const labelKey = LABEL_KEYS.find((k) => typeof o[k] === 'string' || typeof o[k] === 'number');
  const rest = Object.entries(o).filter(([k]) => k !== 'id' && k !== labelKey && !NAME_PARTS.has(k));
  if (rest.length > 4 || rest.some(([, v]) => isObj(v) || Array.isArray(v))) return undefined;
  return `${cut(l, max, true)} [${o.id}]${rest.map(([k, v]) => ` ${k}=${scalar(v, 60)}`).join('')}`;
}

/** `key: value` lines for one record. Small nested refs become `label [id]`, others flatten one level. */
export function record(input: unknown, opts: { maxText?: number; maxRows?: number } = {}): string {
  const maxText = opts.maxText ?? 600;
  const maxRows = opts.maxRows ?? 20;
  const o = clean(input);
  if (!isObj(o)) return Array.isArray(o) ? table(o) : scalar(o, maxText, true);
  const lines: string[] = [];
  const keys = orderColumns(Object.keys(o));
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) {
      if (v.some(isObj)) {
        lines.push(`${k} (${v.length}):`);
        lines.push(table(v.slice(0, maxRows), { maxCell: 50 }));
        if (v.length > maxRows) lines.push(`… ${v.length - maxRows} more`);
      } else lines.push(`${k}: ${cut(v.map((x) => scalar(x, 80)).join(', '), maxText, true)}`);
    } else if (isObj(v)) {
      const ref = refText(v, maxText);
      if (ref) {
        lines.push(`${k}: ${ref}`);
        continue;
      }
      for (const [k2, v2] of Object.entries(v)) {
        const ref2 = isObj(v2) ? refText(v2, maxText) : undefined;
        if (ref2) lines.push(`${k}.${k2}: ${ref2}`);
        else if (isObj(v2) || Array.isArray(v2)) lines.push(`${k}.${k2}: ${cell(v2, 120)}`);
        else lines.push(`${k}.${k2}: ${scalar(v2, maxText, true)}`);
      }
    } else lines.push(`${k}: ${scalar(v, maxText, true)}`);
  }
  return lines.join('\n');
}

/** Render any response body: `{items: [...]}` envelopes as tables, objects as records. */
export function render(data: unknown, opts: { columns?: string[]; maxText?: number; maxCell?: number } = {}): string {
  if (Array.isArray(data)) return table(data, opts);
  if (isObj(data) && Array.isArray(data.items)) return table(data.items, opts);
  return record(data, opts);
}
