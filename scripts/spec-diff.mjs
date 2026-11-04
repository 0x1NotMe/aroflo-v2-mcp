#!/usr/bin/env node
// Diff two extracted AroFlo v2 specs and classify the changes. Schemas are compared recursively
// (nested properties, array items and every allOf/oneOf/anyOf branch). Breaking changes on
// operations or fields listed in spec/used.json are flagged separately.
//
// usage: node scripts/spec-diff.mjs                    # HEAD:spec/aroflo-v2.ops.json vs working copy
//        node scripts/spec-diff.mjs --ref <gitref>     # <gitref>:spec/aroflo-v2.ops.json vs working copy
//        node scripts/spec-diff.mjs old.json new.json
// flags: --fail                exit 1 when a breaking change touches spec/used.json
//        --allow-empty-base    treat a missing baseline as an empty spec (first run only)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const refIdx = args.indexOf('--ref');
const ref = refIdx >= 0 ? args[refIdx + 1] : 'HEAD';
const files = args.filter((a, i) => !a.startsWith('--') && !(refIdx >= 0 && i === refIdx + 1));

function loadBase() {
  if (files.length === 2) return JSON.parse(readFileSync(files[0], 'utf8'));
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:spec/aroflo-v2.ops.json`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    if (flag('--allow-empty-base')) return { paths: {} };
    throw new Error(`cannot load baseline ${ref}:spec/aroflo-v2.ops.json (${err.message.split('\n')[0]}). Pass --allow-empty-base on a first run.`);
  }
}
const base = loadBase();
const next = JSON.parse(readFileSync(files.length === 2 ? files[1] : 'spec/aroflo-v2.ops.json', 'utf8'));

// ---- schema flattening -------------------------------------------------------------------------
const CONSTRAINTS = ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'minItems', 'maxItems', 'multipleOf', 'format', 'const'];

/** path -> {types, enum, required, c} ; paths look like "a", "a.b", "a[]", "a[].b"; "" is the root. */
function flatten(schema, prefix = '', out = new Map()) {
  if (!schema || typeof schema !== 'object') return out;
  let node = out.get(prefix);
  if (!node) out.set(prefix, (node = { types: new Set(), enum: undefined, required: false, c: {} }));
  const t = schema.type;
  if (Array.isArray(t)) t.forEach((x) => node.types.add(x));
  else if (t) node.types.add(t);
  if (schema.nullable === true) node.types.add('null');
  if (Array.isArray(schema.enum)) node.enum = new Set([...(node.enum ?? []), ...schema.enum.map((v) => JSON.stringify(v))]);
  for (const c of CONSTRAINTS) if (schema[c] !== undefined) node.c[c] = schema[c];
  const required = new Set(schema.required ?? []);
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    flatten(v, p, out);
    if (required.has(k)) out.get(p).required = true;
  }
  if (schema.items) flatten(schema.items, `${prefix}[]`, out);
  for (const key of ['allOf', 'oneOf', 'anyOf']) for (const s of schema[key] ?? []) flatten(s, prefix, out);
  return out;
}
const typesOf = (n) => [...n.types].sort().join('|') || 'any';

function tightened(c, oldVal, newVal) {
  if (newVal === undefined) return false;
  if (oldVal === undefined) return true;
  if (['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems'].includes(c)) return newVal < oldVal;
  if (['minLength', 'minimum', 'exclusiveMinimum', 'minItems'].includes(c)) return newVal > oldVal;
  return JSON.stringify(oldVal) !== JSON.stringify(newVal);
}

// ---- collect changes ---------------------------------------------------------------------------
const used = existsSync('spec/used.json') ? (JSON.parse(readFileSync('spec/used.json', 'utf8')).ops ?? {}) : {};
const breaking = [];
const changes = [];
/** field: what the change touches (undefined = whole operation). */
function add(key, msg, isBreaking, field) {
  let hit = false;
  if (isBreaking && key in used) {
    const deps = used[key];
    hit = field === undefined || deps.length === 0 || deps.some((d) => field === d || field.startsWith(`${d}.`) || field.startsWith(`${d}[]`) || d.startsWith(`${field}.`));
  }
  (isBreaking ? breaking : changes).push({ key, msg, used: hit });
}

/** Compare an input schema (params, request body): narrowing is breaking. */
function compareInput(key, label, oldS, newS, rootField) {
  const o = flatten(oldS);
  const n = flatten(newS);
  const fieldOf = (p) => (p ? (rootField ? `${rootField}.${p}` : p) : rootField);
  for (const [p, on] of o) {
    const nn = n.get(p);
    const where = `${label}${p ? ` ${p}` : ''}`;
    if (!nn) {
      add(key, `${where} removed`, true, fieldOf(p));
      continue;
    }
    if (!on.required && nn.required) add(key, `${where} now required`, true);
    const lostTypes = [...on.types].filter((t) => !nn.types.has(t) && !(t === 'integer' && nn.types.has('number')));
    if (on.types.size && nn.types.size && lostTypes.length) add(key, `${where} type ${typesOf(on)} -> ${typesOf(nn)}`, true, fieldOf(p));
    else if (typesOf(on) !== typesOf(nn)) add(key, `${where} type ${typesOf(on)} -> ${typesOf(nn)}`, false, fieldOf(p));
    if (nn.enum && !on.enum) add(key, `${where} enum introduced`, true, fieldOf(p));
    else if (nn.enum && on.enum) {
      const lost = [...on.enum].filter((v) => !nn.enum.has(v));
      const gained = [...nn.enum].filter((v) => !on.enum.has(v));
      if (lost.length) add(key, `${where} enum lost ${lost.join(',')}`, true, fieldOf(p));
      if (gained.length) add(key, `${where} enum gained ${gained.join(',')}`, false, fieldOf(p));
    }
    for (const c of CONSTRAINTS) {
      if (tightened(c, on.c[c], nn.c[c])) add(key, `${where} ${c} ${JSON.stringify(on.c[c] ?? null)} -> ${JSON.stringify(nn.c[c])}`, true, fieldOf(p));
      else if (on.c[c] !== undefined && JSON.stringify(on.c[c]) !== JSON.stringify(nn.c[c])) add(key, `${where} ${c} relaxed`, false, fieldOf(p));
    }
  }
  for (const [p, nn] of n) {
    if (o.has(p)) continue;
    const where = `${label}${p ? ` ${p}` : ''}`;
    add(key, `${where} added${nn.required ? ' (required)' : ''}`, nn.required, nn.required ? undefined : fieldOf(p));
  }
}

/** Compare an output schema (responses): any removal or type change is breaking for readers. */
function compareOutput(key, label, oldS, newS) {
  const o = flatten(oldS);
  const n = flatten(newS);
  for (const [p, on] of o) {
    const nn = n.get(p);
    const where = `${label}${p ? ` ${p}` : ''}`;
    if (!nn) add(key, `${where} removed`, true, p.replace(/^items\[\]\.?/, '') || undefined);
    else if (typesOf(on) !== typesOf(nn) && on.types.size && nn.types.size) add(key, `${where} type ${typesOf(on)} -> ${typesOf(nn)}`, true, p.replace(/^items\[\]\.?/, '') || undefined);
  }
  for (const p of n.keys()) if (!o.has(p)) add(key, `${label} ${p} added`, false, p);
}

const opsOf = (spec) => {
  const out = new Map();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) for (const [m, op] of Object.entries(methods)) out.set(`${m.toUpperCase()} ${path}`, op);
  return out;
};
const oldOps = opsOf(base);
const newOps = opsOf(next);

for (const key of oldOps.keys()) if (!newOps.has(key)) add(key, 'operation removed', true);
for (const key of newOps.keys()) if (!oldOps.has(key)) add(key, 'operation added', false);

for (const [key, nu] of newOps) {
  const old = oldOps.get(key);
  if (!old) continue;

  const op = new Map((old.parameters ?? []).map((p) => [p.name, p]));
  const np = new Map((nu.parameters ?? []).map((p) => [p.name, p]));
  for (const [name, p] of op) {
    const q = np.get(name);
    if (!q) {
      add(key, `param ${name} removed`, true, `param:${name}`);
      continue;
    }
    if (p.in !== q.in) add(key, `param ${name} moved ${p.in} -> ${q.in}`, true);
    if (!p.required && q.required) add(key, `param ${name} now required`, true);
    compareInput(key, `param ${name}`, p.schema, q.schema, `param:${name}`);
  }
  for (const [name, q] of np) if (!op.has(name)) add(key, `param ${name} added${q.required ? ' (required)' : ''}`, Boolean(q.required), q.required ? undefined : `param:${name}`);

  const ob = old.requestBody;
  const nb = nu.requestBody;
  if (ob || nb) {
    if (!ob?.required && nb?.required) add(key, 'request body now required', true);
    const om = Object.keys(ob?.content ?? {});
    const nm = Object.keys(nb?.content ?? {});
    for (const m of om) if (!nm.includes(m)) add(key, `request media type ${m} removed`, true);
    for (const m of nm) if (!om.includes(m)) add(key, `request media type ${m} added`, false);
    for (const m of nm.filter((x) => om.includes(x))) compareInput(key, `body(${m === 'application/json' ? 'json' : m})`, ob.content[m].schema, nb.content[m].schema);
  }

  const oc = Object.keys(old.responses ?? {});
  const nc = Object.keys(nu.responses ?? {});
  for (const c of oc) if (!nc.includes(c)) add(key, `response ${c} removed`, /^2/.test(c));
  for (const c of nc) if (!oc.includes(c)) add(key, `response ${c} added`, false);
  for (const c of nc.filter((x) => oc.includes(x) && /^2/.test(x))) {
    const om = Object.keys(old.responses[c]?.content ?? {});
    const nm = Object.keys(nu.responses[c]?.content ?? {});
    for (const m of om) if (!nm.includes(m)) add(key, `response ${c} media type ${m} removed`, true);
    const os = old.responses[c]?.content?.['application/json']?.schema;
    const ns = nu.responses[c]?.content?.['application/json']?.schema;
    if (os || ns) compareOutput(key, `response ${c}`, os, ns);
  }
}

// ---- report ------------------------------------------------------------------------------------
const usedHits = breaking.filter((b) => b.used);
const lines = [`# AroFlo v2 spec diff`, '', `${breaking.length} breaking, ${changes.length} other changes. ${usedHits.length} breaking changes touch this server (spec/used.json).`, ''];
const section = (title, list) => {
  if (!list.length) return;
  lines.push(`## ${title}`, '');
  for (const x of list) lines.push(`- \`${x.key}\`: ${x.msg}`);
  lines.push('');
};
section('Breaking changes this server depends on', usedHits);
section('All breaking changes', breaking);
section('Other changes', changes);
process.stdout.write(`${lines.join('\n')}\n`);
if (flag('--fail') && usedHits.length) process.exit(1);
