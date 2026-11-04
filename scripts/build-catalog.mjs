#!/usr/bin/env node
// Build the compact runtime catalog (spec/catalog.json) from the extracted ops (spec/aroflo-v2.ops.json).
// The server loads only the catalog: params, a normalised request-body schema for write validation,
// top-level response field names, and the description text for aroflo_api.
// usage: node scripts/build-catalog.mjs [opsFile] [catalogFile]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const opsFile = process.argv[2] ?? 'spec/aroflo-v2.ops.json';
const outFile = process.argv[3] ?? 'spec/catalog.json';
const raw = readFileSync(opsFile, 'utf8');
const spec = JSON.parse(raw);

const KEEP = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'maxLength', 'minLength', 'maximum', 'minimum',
  'maxItems', 'minItems', 'pattern', 'oneOf', 'anyOf', 'allOf', 'default', 'description', 'format',
  'additionalProperties', 'const'
]);

const short = (s, n) => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || undefined;
};

// Normalise an OpenAPI schema into plain JSON Schema for Ajv: nullable -> type union, drop examples,
// short descriptions, and close objects (additionalProperties:false) so undocumented fields are
// rejected instead of being silently ignored by AroFlo.
function normalise(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return schema;
  if (Array.isArray(schema)) return schema.map((s) => normalise(s, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!KEEP.has(k)) continue;
    if (k === 'description') out.description = short(v, 140);
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, normalise(pv, depth + 1)]));
    else if (k === 'items' || k === 'additionalProperties') out[k] = typeof v === 'object' ? normalise(v, depth + 1) : v;
    else if (k === 'oneOf' || k === 'anyOf' || k === 'allOf') out[k] = v.map((s) => normalise(s, depth + 1));
    else out[k] = v;
  }
  if (schema.nullable === true && out.type && !Array.isArray(out.type)) out.type = [out.type, 'null'];
  if (out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  if (out.description === undefined) delete out.description;
  return out;
}

// Top-level property names of a schema, merging allOf members (AroFlo composes list items that way).
function propsOf(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  const merged = { ...(schema.properties ?? {}) };
  for (const part of schema.allOf ?? []) Object.assign(merged, propsOf(part) ?? {});
  if (!Object.keys(merged).length && (schema.oneOf ?? schema.anyOf)?.[0]) return propsOf((schema.oneOf ?? schema.anyOf)[0]);
  return Object.keys(merged).length ? merged : undefined;
}

function typeOf(schema) {
  if (!schema) return undefined;
  const t = schema.type;
  if (Array.isArray(t)) return t.filter((x) => x !== 'null').join('|');
  return t;
}

const ops = [];
for (const path of Object.keys(spec.paths).sort()) {
  for (const method of Object.keys(spec.paths[path]).sort()) {
    const op = spec.paths[path][method];
    const M = method.toUpperCase();
    const params = op.parameters ?? [];
    const q = params
      .filter((p) => p.in === 'query')
      .map((p) => {
        const s = p.schema ?? {};
        const e = { n: p.name };
        const t = typeOf(s);
        if (t) e.t = t;
        if (p.required) e.r = 1;
        if (Array.isArray(s.enum)) e.e = s.enum;
        if (s.default !== undefined) e.def = s.default;
        if (s.minimum !== undefined) e.min = s.minimum;
        if (s.maximum !== undefined) e.max = s.maximum;
        if (s.format) e.fmt = s.format;
        const d = short(p.description, 110);
        if (d) e.d = d;
        return e;
      });
    const pp = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const content = op.requestBody?.content ?? {};
    const okCode = ['200', '201', '207', '204'].find((c) => op.responses?.[c]);
    const rs = op.responses?.[okCode]?.content?.['application/json']?.schema;
    const top = propsOf(rs);
    const isList = top?.items?.type === 'array';
    const fieldSource = isList ? propsOf(top.items.items) : top;
    const entry = {
      k: `${M} ${path}`,
      m: M,
      p: path,
      tags: op.tags ?? [],
      s: op.summary ?? '',
      d: (op.description ?? '').trim(),
      q,
      pp,
      codes: Object.keys(op.responses ?? {}).map(Number).sort((a, b) => a - b)
    };
    if (content['application/json']?.schema) entry.b = normalise(content['application/json'].schema);
    if (content['application/octet-stream']) entry.bin = 1;
    if (op.requestBody?.required) entry.br = 1;
    if (fieldSource) entry.f = Object.keys(fieldSource);
    if (isList) entry.list = 1;
    if (top?.page) entry.paged = 1;
    if (M !== 'GET' && op.jsonRequestBodyExample !== undefined) entry.ex = op.jsonRequestBodyExample;
    ops.push(entry);
  }
}

const catalog = {
  version: spec.info?.version ?? 'unknown',
  specSha: createHash('sha256').update(raw).digest('hex').slice(0, 12),
  ops
};
writeFileSync(outFile, `${JSON.stringify(catalog)}\n`);
const writes = ops.filter((o) => o.m !== 'GET').length;
console.log(`catalog: ${ops.length} ops (${writes} non-GET), ${(JSON.stringify(catalog).length / 1024).toFixed(0)} KB -> ${outFile}`);
