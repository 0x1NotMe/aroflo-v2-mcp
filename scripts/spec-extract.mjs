#!/usr/bin/env node
// Rebuild the AroFlo v2 OpenAPI operations from the public docs site.
//
// AroFlo publishes no OpenAPI file. docs.api.aroflo.com is a client-rendered Docusaurus build:
// each endpoint page's JS chunk carries its OpenAPI operation as a zlib+base64 "api" string.
// This script maps routes to chunks, downloads them and decodes them. Downloaded JS is parsed
// as text and never executed.
//
// usage: node scripts/spec-extract.mjs [opsFile] [releaseNotesFile]
//        defaults: spec/aroflo-v2.ops.json spec/release-notes.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateSync } from 'node:zlib';

const SITE = 'https://docs.api.aroflo.com';
const opsFile = process.argv[2] ?? 'spec/aroflo-v2.ops.json';
const notesFile = process.argv[3] ?? 'spec/release-notes.json';

async function fetchText(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'aroflo-v2-mcp spec-extract' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    );
  }
  return value;
}

const shell = await fetchText(`${SITE}/`);
const runtimePath = shell.match(/\/assets\/js\/runtime~main\.[0-9a-f]+\.js/)?.[0];
const mainPath = shell.match(/\/assets\/js\/main\.[0-9a-f]+\.js/)?.[0];
if (!runtimePath || !mainPath) throw new Error('docs shell changed: runtime/main bundle not found');
const [runtime, main] = await Promise.all([fetchText(SITE + runtimePath), fetchText(SITE + mainPath)]);

// Webpack runtime: u=e=>"assets/js/"+(({<id>:"<name>",...})[e]||e)+"."+({<id>:"<hash>",...})[e]+".js"
const u = runtime.match(/"assets\/js\/"\+\(\(\{([^}]*)\}\)\[e\]\|\|e\)\+"\."\+\(\{([^}]*)\}\)\[e\]\+"\.js"/);
if (!u) throw new Error('docs runtime changed: chunk filename map not found');
const parseMap = (s) => Object.fromEntries([...s.matchAll(/(\d+):"([0-9a-f]+)"/g)].map((m) => [m[1], m[2]]));
const names = parseMap(u[1]);
const hashes = parseMap(u[2]);

// Route registry entries: "<key>":[()=>Promise.all([n.e("4014"),...,n.e("9376")]).then(...),"@site/docs/api/x.api.mdx",<module>]
const routeRe =
  /"?[0-9a-f]+"?:\[\(\)=>(Promise\.all\(\[[^\]]*\]\)|[\w$]+\.e\("\d+"\))\.then\([\w$]+\.(?:t\.)?bind\([\w$]+,\d+(?:,\d+)?\)\),"(@site\/[^"]+)"/g;
const routes = new Map(); // source -> candidate chunk URLs, most specific (last) first
for (const m of main.matchAll(routeRe)) {
  const ids = [...m[1].matchAll(/\.e\("(\d+)"\)/g)].map((x) => x[1]).reverse();
  const urls = ids.filter((id) => hashes[id]).map((id) => `${SITE}/assets/js/${names[id] ?? id}.${hashes[id]}.js`);
  if (urls.length) routes.set(m[2], urls);
}

// Inventory every endpoint page the bundle mentions, independently of the registry regex, so a
// registry entry in an unexpected shape fails the run instead of silently dropping an endpoint.
const apiSources = [...new Set([...main.matchAll(/"(@site\/docs\/api\/[^"]+\.api\.mdx)"/g)].map((m) => m[1]))];
const unresolved = apiSources.filter((src) => !routes.has(src));
if (unresolved.length) throw new Error(`${unresolved.length} API pages could not be mapped to chunks: ${unresolved.slice(0, 5).join(', ')}`);
if (apiSources.length < 100) throw new Error(`only ${apiSources.length} API pages found; the docs build changed`);

const METHODS = new Set(['get', 'post', 'patch', 'put', 'delete']);
const decoded = await mapLimit(apiSources, 6, async (src) => {
  for (const url of routes.get(src)) {
    const js = await fetchText(url);
    if (!js.includes(`"source":"${src}"`)) continue; // a shared dependency chunk, not this page
    const blobs = [...new Set([...js.matchAll(/"api":"(eJ[A-Za-z0-9+/=]+)"/g)].map((m) => m[1]))];
    if (blobs.length !== 1) throw new Error(`${src}: expected one api blob, found ${blobs.length}`);
    const op = JSON.parse(inflateSync(Buffer.from(blobs[0], 'base64')).toString('utf8'));
    if (!METHODS.has(op.method) || typeof op.path !== 'string' || !op.path.startsWith('/') || typeof op.responses !== 'object') {
      throw new Error(`${src}: decoded operation is malformed`);
    }
    return op;
  }
  throw new Error(`${src}: no chunk carries this page`);
});

const spec = { source: SITE, info: undefined, servers: undefined, securitySchemes: undefined, paths: {} };
for (const op of decoded) {
  spec.info ??= op.info ? { title: op.info.title, version: op.info.version } : undefined;
  spec.servers ??= op.servers;
  spec.securitySchemes ??= op.securitySchemes;
  const { method, path, info, servers, securitySchemes, security, postman, ...rest } = op;
  rest.summary = postman?.name ?? rest.summary;
  spec.paths[path] ??= {};
  if (spec.paths[path][method]) throw new Error(`duplicate operation ${method.toUpperCase()} ${path}`);
  spec.paths[path][method] = rest;
}

// Release notes: the page metadata is a JSON text inside a JS single-quoted string literal,
// JSON.parse('...'). Decode the literal's escapes by hand (never eval) and parse the JSON.
function decodeJsSingleQuoted(lit) {
  return lit.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] ?? e;
  });
}
function pageMetadata(js) {
  const at = js.indexOf("JSON.parse('");
  if (at < 0) return undefined;
  let i = at + "JSON.parse('".length;
  let lit = '';
  for (; i < js.length; i++) {
    const ch = js[i];
    if (ch === '\\') {
      lit += ch + js[i + 1];
      i++;
    } else if (ch === "'") break;
    else lit += ch;
  }
  return JSON.parse(decodeJsSingleQuoted(lit));
}
const noteSources = [...routes.keys()].filter((src) => /^@site\/blog\/.+api-changes\.md$/.test(src));
const notes = await mapLimit(noteSources, 4, async (src) => {
  for (const url of routes.get(src)) {
    const js = await fetchText(url);
    if (!js.includes(src)) continue;
    const md = pageMetadata(js);
    if (!md?.title || !md.date || !md.permalink) throw new Error(`${src}: release-note metadata missing title/date/permalink`);
    return { date: String(md.date).slice(0, 10), title: md.title, summary: md.description ?? '', url: SITE + md.permalink };
  }
  throw new Error(`${src}: no chunk carries this release note`);
});
if (!notes.length) throw new Error('no release notes found; the docs blog changed');
notes.sort((a, b) => b.date.localeCompare(a.date));

mkdirSync(dirname(opsFile), { recursive: true });
writeFileSync(opsFile, `${JSON.stringify(sortKeys(spec), null, 1)}\n`);
writeFileSync(notesFile, `${JSON.stringify(notes, null, 1)}\n`);
const count = Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`spec: ${count} operations on ${Object.keys(spec.paths).length} paths -> ${opsFile}`);
console.log(`release notes: ${notes.length} -> ${notesFile}`);
