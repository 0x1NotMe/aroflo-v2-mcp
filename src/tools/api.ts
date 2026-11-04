import type { Method, Op, Param } from '../catalog.js';
import type { Config } from '../config.js';
import { DEFAULT_FIELDS } from '../defaults.js';
import { cut, isObj, type Obj } from '../format.js';
import { splitPath, UsageError } from '../request.js';
import { writeAllowed } from '../writes.js';
import { str, type Tool } from './types.js';

const PAGING = new Set(['page', 'limit', '_fields']);

const filterNames = (op: Op) => op.q.filter((p) => !PAGING.has(p.n)).map((p) => p.n + (p.r ? '*' : ''));

function searchLine(op: Op): string {
  const f = filterNames(op);
  const shown = f.length > 8 ? `${f.slice(0, 8).join(', ')} +${f.length - 8}` : f.join(', ');
  return `${op.k}\t${op.s}${shown ? `\tfilters: ${shown}` : ''}`;
}

function paramLine(p: Param): string {
  const type = p.e ? p.e.join('|') : (p.fmt ?? p.t ?? 'string');
  return `  ${p.n}${p.r ? '*' : ''} (${type})${p.d ? ` ${cut(p.d, 100)}` : ''}`;
}

function typeLabel(s: Obj): string {
  if (Array.isArray(s.enum)) return s.enum.join('|');
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null').join('|') : typeof s.type === 'string' ? s.type : 'any';
  if (t === 'array' && isObj(s.items)) return `array of ${typeLabel(s.items)}`;
  const limits = [s.maxLength !== undefined ? `max ${s.maxLength}` : '', s.format ? String(s.format) : ''].filter(Boolean).join(', ');
  return limits ? `${t}, ${limits}` : t;
}

/** Request-body fields, two levels deep, `*` = required. */
function bodyLines(s: Obj, indent: string, depth: number, out: string[] = []): string[] {
  const props = isObj(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  for (const [k, raw] of Object.entries(props)) {
    if (!isObj(raw)) continue;
    const d = typeof raw.description === 'string' ? ` ${cut(raw.description, 90)}` : '';
    out.push(`${indent}${k}${required.has(k) ? '*' : ''} (${typeLabel(raw)})${d}`);
    const child = isObj(raw.items) && isObj(raw.items.properties) ? raw.items : isObj(raw.properties) ? raw : undefined;
    if (child && depth < 2) bodyLines(child, `${indent}  `, depth + 1, out);
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const alts = s[key];
    if (!Array.isArray(alts)) continue;
    const names = alts.map((b) => (isObj(b) && Array.isArray(b.required) && b.required.length ? b.required.join('+') : isObj(b) ? typeLabel(b) : '?'));
    out.push(`${indent}${key === 'oneOf' ? 'exactly one of' : 'at least one of'}: ${names.join(' | ')}`);
  }
  return out;
}

export function describe(op: Op, cfg: Config): string {
  const lines = [`${op.k}: ${op.s}`];
  if (op.m !== 'GET' && !writeAllowed(cfg, op)) lines.push('(writes to this endpoint are not enabled on this server)');
  const params = op.q.filter((p) => p.n !== '_fields');
  if (params.length) lines.push('query:', ...params.map(paramLine));
  if (op.m === 'GET' && op.f) {
    lines.push(`fields: ${op.f.filter((f) => f !== '_links').join(', ')}`);
    if (DEFAULT_FIELDS[op.k]) lines.push(`default fields: ${DEFAULT_FIELDS[op.k]} (full=true for all)`);
  }
  if (op.b && op.m !== 'GET') lines.push('body:', ...bodyLines(op.b, '  ', 0));
  if (op.ex !== undefined && op.m !== 'GET') lines.push(`example: ${cut(JSON.stringify(op.ex), 600)}`);
  if (op.d) lines.push(`notes: ${cut(op.d.replace(/\s+/g, ' ').trim(), 1200, true)}`);
  return lines.join('\n');
}

const WRITE_WORDS = /\b(create|add|new|update|edit|change|patch|set|delete|remove|archive|upload|post|insert|assign)\b/i;

export const apiTool: Tool = {
  def: {
    name: 'aroflo_api',
    description: "Look up AroFlo v2 endpoints. q = words ('quote line items', 'timesheets') for matching endpoints, or 'GET /tasks' for one endpoint's filters, fields and rules.",
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },

  async run(args, d) {
    const q = str(args, 'q');
    const exact = /^(GET|POST|PATCH|PUT|DELETE)\s+(\S+)$/i.exec(q);
    if (exact) {
      const method = exact[1]!.toUpperCase() as Method;
      const { path } = splitPath(exact[2]!);
      const op = d.catalog.get(`${method} ${path}`) ?? d.catalog.match(method, path)?.op;
      if (!op) {
        const others = d.catalog.methodsFor(path);
        throw new UsageError(others.length ? `${method} ${path} does not exist; ${path} supports ${others.join(', ')}.` : `No endpoint ${method} ${path}. Search with words instead.`);
      }
      return describe(op, d.cfg);
    }
    const writes = d.cfg.writeOps.length > 0;
    const hits = d.catalog.search(q, { limit: 12, methods: writes ? undefined : ['GET'] }).filter((op) => op.m === 'GET' || writeAllowed(d.cfg, op));
    const readOnlyNote = !writes && WRITE_WORDS.test(q) ? '\n(This server is read-only.)' : '';
    if (!hits.length) return `No endpoint matches "${q}".${readOnlyNote}`;
    return `${hits.map(searchLine).join('\n')}\n'GET /path' for details.${readOnlyNote}`;
  }
};
