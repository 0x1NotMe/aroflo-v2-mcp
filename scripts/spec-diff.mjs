#!/usr/bin/env node
// Diff two extracted AroFlo v2 specs and classify the changes. Breaking changes on operations or
// fields listed in spec/used.json (what this server depends on) are flagged separately.
// usage: node scripts/spec-diff.mjs                 # HEAD:spec/aroflo-v2.ops.json vs working copy
//        node scripts/spec-diff.mjs --ref <gitref>  # <gitref>:spec/aroflo-v2.ops.json vs working copy
//        node scripts/spec-diff.mjs old.json new.json
//        add --fail to exit 1 when a breaking change touches spec/used.json
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const fail = args.includes('--fail');
const files = args.filter((a) => !a.startsWith('--'));
const refIdx = args.indexOf('--ref');
const ref = refIdx >= 0 ? args[refIdx + 1] : 'HEAD';

function load(which) {
  if (files.length === 2) return JSON.parse(readFileSync(files[which === 'old' ? 0 : 1], 'utf8'));
  if (which === 'new') return JSON.parse(readFileSync('spec/aroflo-v2.ops.json', 'utf8'));
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:spec/aroflo-v2.ops.json`], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  } catch {
    return { paths: {} };
  }
}

const propsOf = (s) => {
  if (!s || typeof s !== 'object') return {};
  const m = { ...(s.properties ?? {}) };
  for (const p of s.allOf ?? []) Object.assign(m, propsOf(p));
  if (!Object.keys(m).length && (s.oneOf ?? s.anyOf)?.[0]) return propsOf((s.oneOf ?? s.anyOf)[0]);
  return m;
};
const typeStr = (s) => {
  if (!s) return 'any';
  if (Array.isArray(s.type)) return [...s.type].sort().join('|');
  if (s.type) return s.type + (s.nullable ? '|null' : '');
  if (s.oneOf || s.anyOf) return 'union';
  return s.allOf ? 'object' : 'any';
};
const ops = (spec) => {
  const out = new Map();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [m, op] of Object.entries(methods)) out.set(`${m.toUpperCase()} ${path}`, op);
  }
  return out;
};
const respFields = (op) => {
  for (const c of ['200', '201', '207']) {
    const s = op.responses?.[c]?.content?.['application/json']?.schema;
    if (!s) continue;
    const top = propsOf(s);
    return top.items?.type === 'array' ? propsOf(top.items.items) : top;
  }
  return {};
};

const oldOps = ops(load('old'));
const newOps = ops(load('new'));
const used = existsSync('spec/used.json') ? JSON.parse(readFileSync('spec/used.json', 'utf8')).ops ?? {} : {};

const breaking = [];
const changes = [];
const add = (key, msg, isBreaking, field) => {
  const hit = key in used && (field === undefined || used[key].length === 0 || used[key].includes(field));
  (isBreaking ? breaking : changes).push({ key, msg, used: isBreaking && hit });
};

for (const key of oldOps.keys()) if (!newOps.has(key)) add(key, 'operation removed', true);
for (const key of newOps.keys()) if (!oldOps.has(key)) add(key, 'operation added', false);

for (const [key, nu] of newOps) {
  const old = oldOps.get(key);
  if (!old) continue;
  const op = new Map((old.parameters ?? []).map((p) => [`${p.in}:${p.name}`, p]));
  const np = new Map((nu.parameters ?? []).map((p) => [`${p.in}:${p.name}`, p]));
  for (const [id, p] of op) {
    const q = np.get(id);
    if (!q) add(key, `param ${p.name} removed`, true, `param:${p.name}`);
    else {
      if (!p.required && q.required) add(key, `param ${p.name} now required`, true, `param:${p.name}`);
      if (typeStr(p.schema) !== typeStr(q.schema)) add(key, `param ${p.name} type ${typeStr(p.schema)} -> ${typeStr(q.schema)}`, true, `param:${p.name}`);
      const lost = (p.schema?.enum ?? []).filter((v) => !(q.schema?.enum ?? []).includes(v));
      if (q.schema?.enum && lost.length) add(key, `param ${p.name} enum lost ${lost.join(',')}`, true, `param:${p.name}`);
    }
  }
  for (const [id, q] of np) if (!op.has(id)) add(key, `param ${q.name} added${q.required ? ' (required)' : ''}`, Boolean(q.required), `param:${q.name}`);

  const ob = old.requestBody?.content?.['application/json']?.schema;
  const nb = nu.requestBody?.content?.['application/json']?.schema;
  if (ob || nb) {
    const oprops = propsOf(ob);
    const nprops = propsOf(nb);
    const oreq = new Set(ob?.required ?? []);
    const nreq = new Set(nb?.required ?? []);
    for (const f of Object.keys(oprops)) {
      if (!(f in nprops)) add(key, `body field ${f} removed`, true, `body:${f}`);
      else if (typeStr(oprops[f]) !== typeStr(nprops[f])) add(key, `body field ${f} type ${typeStr(oprops[f])} -> ${typeStr(nprops[f])}`, true, `body:${f}`);
    }
    for (const f of nreq) if (!oreq.has(f)) add(key, `body field ${f} now required`, true, `body:${f}`);
    for (const f of Object.keys(nprops)) if (!(f in oprops)) add(key, `body field ${f} added`, false, `body:${f}`);
  }

  const of = respFields(old);
  const nf = respFields(nu);
  for (const f of Object.keys(of)) {
    if (!(f in nf)) add(key, `response field ${f} removed`, true, f);
    else if (typeStr(of[f]) !== typeStr(nf[f])) add(key, `response field ${f} type ${typeStr(of[f])} -> ${typeStr(nf[f])}`, true, f);
  }
  for (const f of Object.keys(nf)) if (!(f in of)) add(key, `response field ${f} added`, false, f);
}

const lines = [];
const usedHits = breaking.filter((b) => b.used);
lines.push(`# AroFlo v2 spec diff`, '', `${breaking.length} breaking, ${changes.length} other changes. ${usedHits.length} breaking changes touch this server (spec/used.json).`, '');
if (usedHits.length) {
  lines.push('## Breaking changes this server depends on', '');
  for (const b of usedHits) lines.push(`- \`${b.key}\`: ${b.msg}`);
  lines.push('');
}
if (breaking.length) {
  lines.push('## All breaking changes', '');
  for (const b of breaking) lines.push(`- \`${b.key}\`: ${b.msg}`);
  lines.push('');
}
if (changes.length) {
  lines.push('## Other changes', '');
  for (const c of changes) lines.push(`- \`${c.key}\`: ${c.msg}`);
  lines.push('');
}
process.stdout.write(`${lines.join('\n')}\n`);
if (fail && usedHits.length) process.exit(1);
