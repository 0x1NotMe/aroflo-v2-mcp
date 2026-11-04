import type { ApiCatalog, Method, Op, Param } from './catalog.js';

/** A mistake the model can fix from the message alone. No API call was made. */
export class UsageError extends Error {}

export interface BusinessUnitSource {
  businessUnitId(): Promise<string>;
}

export interface Target {
  op: Op;
  /** Concrete path, ids filled in. */
  path: string;
  /** Path parameter values as filled in (business-unit placeholders resolved). */
  params: Record<string, string>;
  search: URLSearchParams;
}

/** Path and query parameters that take the default business unit when left out or given as a placeholder. */
const BU_NAMES = new Set(['businessUnitId', 'business_unit_id', 'orgId']);
const PLACEHOLDER = /^(\{[^}]*\}|-|_|default)$/i;

/** Accepts "/tasks?status=1", "tasks?status=1" or a full https://api.aroflo.com/v2/... URL. */
export function splitPath(input: string): { path: string; search: URLSearchParams } {
  let s = input.trim();
  s = s.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/v2(?=\/|$)/i, '');
  if (!s.startsWith('/')) s = `/${s}`;
  const q = s.indexOf('?');
  const path = (q >= 0 ? s.slice(0, q) : s).replace(/\/+$/, '') || '/';
  return { path, search: new URLSearchParams(q >= 0 ? s.slice(q + 1) : '') };
}

export async function resolveTarget(catalog: ApiCatalog, method: Method, input: string, bu: BusinessUnitSource): Promise<Target> {
  const { path, search } = splitPath(input);
  const match = catalog.match(method, path);
  if (!match) {
    const others = catalog.methodsFor(path);
    if (others.length) throw new UsageError(`${method} is not available on ${path}; it supports ${others.join(', ')}.`);
    const close = catalog
      .search(path.replace(/[{}]/g, ' '), { methods: [method], limit: 5 })
      .map((o) => o.p)
      .join(', ');
    throw new UsageError(`No ${method} endpoint matches ${path}.${close ? ` Close: ${close}.` : ''} aroflo_api lists them.`);
  }
  let concrete = match.op.p;
  const params: Record<string, string> = {};
  for (const name of match.op.pp) {
    let value = match.params[name] ?? '';
    // Ids are opaque tokens. "..", "." or a decoded slash would let URL normalisation send the request
    // to a different endpoint than the one validated (and, for writes, allowlisted).
    if (/^\.{1,2}$/.test(value) || /[/\\\u0000-\u001f\u007f]/.test(value)) throw new UsageError(`Invalid ${name}: "${value}".`);
    if (PLACEHOLDER.test(value)) {
      if (!BU_NAMES.has(name)) throw new UsageError(`${match.op.p} needs a real ${name}, not ${value}.`);
      value = await bu.businessUnitId();
    }
    params[name] = value;
    concrete = concrete.replace(`{${name}}`, encodeURIComponent(value));
  }
  return { op: match.op, path: concrete, params, search };
}

function coerce(p: Param, raw: string): string {
  const v = raw.trim();
  if (p.e) {
    // Integer flags such as allStatus take 0/1; accept true/false for them.
    const flag = { true: '1', yes: '1', false: '0', no: '0' }[v.toLowerCase()];
    const probe = flag !== undefined && p.e.every((x) => typeof x === 'number') ? flag : v;
    const hit = p.e.find((x) => String(x).toLowerCase() === probe.toLowerCase());
    if (hit === undefined) throw new UsageError(`${p.n} must be one of ${p.e.join(', ')}${p.d ? ` (${p.d})` : ''}.`);
    return String(hit);
  }
  if (p.t === 'integer' || p.t === 'number') {
    const n = Number(v);
    if (v === '' || !Number.isFinite(n) || (p.t === 'integer' && !Number.isInteger(n))) throw new UsageError(`${p.n} must be ${p.t === 'integer' ? 'an integer' : 'a number'}${p.d ? ` (${p.d})` : ''}.`);
    if (p.min !== undefined && n < p.min) throw new UsageError(`${p.n} must be at least ${p.min}.`);
    if (p.max !== undefined && n > p.max) throw new UsageError(`${p.n} must be at most ${p.max}.`);
    return v;
  }
  if (p.t === 'boolean') {
    const l = v.toLowerCase();
    if (['true', '1', 'yes'].includes(l)) return 'true';
    if (['false', '0', 'no'].includes(l)) return 'false';
    throw new UsageError(`${p.n} must be true or false.`);
  }
  if (p.fmt === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UsageError(`${p.n} must be a date, YYYY-MM-DD.`);
  if (p.fmt === 'date-time' && Number.isNaN(Date.parse(v))) throw new UsageError(`${p.n} must be an ISO 8601 date-time, e.g. 2026-11-01T00:00:00Z.`);
  return v;
}

/** Top-level names in a `_fields` value: "id,client[name,id],status" -> id, client, status. */
export function fieldNames(fields: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of fields) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else if (depth === 0 && ch !== ']') cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Validate and normalise query parameters against the catalog: unknown names, enums (case-insensitive),
 * numbers, booleans and dates. Required business-unit parameters are filled with the default unit.
 */
export async function buildQuery(op: Op, search: URLSearchParams, bu: BusinessUnitSource): Promise<Record<string, string>> {
  const byName = new Map(op.q.map((p) => [p.n.toLowerCase(), p]));
  const query: Record<string, string> = {};
  for (const [k, v] of search) {
    const p = byName.get(k.toLowerCase());
    if (!p) {
      const valid = op.q.map((x) => x.n).filter((n) => n !== '_fields');
      throw new UsageError(valid.length ? `${op.k} has no filter "${k}". Valid: ${valid.join(', ')}.` : `${op.k} takes no query parameters.`);
    }
    if (BU_NAMES.has(p.n) && (v.trim() === '' || PLACEHOLDER.test(v.trim()))) {
      query[p.n] = await bu.businessUnitId();
      continue;
    }
    if (v.trim() === '') {
      if (p.r) throw new UsageError(`${p.n} needs a value.`);
      continue;
    }
    if (p.n === '_fields') {
      const unknown = op.f ? fieldNames(v).filter((f) => !op.f!.includes(f)) : [];
      if (unknown.length) throw new UsageError(`${op.k} has no field ${unknown.join(', ')}. Fields: ${op.f!.filter((f) => f !== '_links').join(', ')}.`);
      query._fields = v.replace(/\s+/g, '');
      continue;
    }
    query[p.n] = coerce(p, v);
  }
  for (const p of op.q) {
    if (!p.r || query[p.n] !== undefined) continue;
    if (BU_NAMES.has(p.n)) query[p.n] = await bu.businessUnitId();
    else {
      const hint = p.e ? `one of ${p.e.join(', ')}` : p.fmt === 'date' ? 'YYYY-MM-DD' : p.t;
      throw new UsageError(`${op.k} needs ${p.n}${hint ? ` (${hint})` : ''}${p.d ? `: ${p.d}` : ''}.`);
    }
  }
  return query;
}
