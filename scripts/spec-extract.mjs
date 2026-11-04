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
const routes = new Map();
const routeRe =
  /"?[0-9a-f]+"?:\[\(\)=>(Promise\.all\(\[[^\]]*\]\)|[\w$]+\.e\("\d+"\))\.then\([\w$]+\.(?:t\.)?bind\([\w$]+,\d+(?:,\d+)?\)\),"(@site\/[^"]+)"/g;
for (const m of main.matchAll(routeRe)) {
  const ids = [...m[1].matchAll(/\.e\("(\d+)"\)/g)].map((x) => x[1]);
  const cid = ids.at(-1);
  if (!cid || !hashes[cid]) continue;
  routes.set(m[2], `${SITE}/assets/js/${names[cid] ?? cid}.${hashes[cid]}.js`);
}

const apiRoutes = [...routes].filter(([src]) => /^@site\/docs\/api\/.+\.api\.mdx$/.test(src));
if (apiRoutes.length < 100) throw new Error(`only ${apiRoutes.length} API routes found; the docs build changed`);

const decoded = await mapLimit(apiRoutes, 6, async ([src, url]) => {
  const js = await fetchText(url);
  const blob = js.match(/"api":"(eJ[A-Za-z0-9+/=]+)"/)?.[1];
  if (!blob) throw new Error(`no api blob in ${src}`);
  return JSON.parse(inflateSync(Buffer.from(blob, 'base64')).toString('utf8'));
});

const spec = { source: SITE, info: undefined, servers: undefined, securitySchemes: undefined, paths: {} };
for (const op of decoded) {
  spec.info ??= op.info ? { title: op.info.title, version: op.info.version } : undefined;
  spec.servers ??= op.servers;
  spec.securitySchemes ??= op.securitySchemes;
  const { method, path, info, servers, securitySchemes, security, postman, ...rest } = op;
  rest.summary = postman?.name ?? rest.summary;
  (spec.paths[path] ??= {})[method] = rest;
}

const notes = await mapLimit(
  [...routes].filter(([src]) => /^@site\/blog\/.+api-changes\.md$/.test(src)),
  4,
  async ([, url]) => {
    const js = await fetchText(url);
    const pick = (key) => js.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
    return { date: pick('date')?.slice(0, 10), title: pick('title'), summary: pick('description'), url: SITE + (pick('permalink') ?? '') };
  }
);
notes.sort((a, b) => String(b.date).localeCompare(String(a.date)));

mkdirSync(dirname(opsFile), { recursive: true });
writeFileSync(opsFile, `${JSON.stringify(sortKeys(spec), null, 1)}\n`);
writeFileSync(notesFile, `${JSON.stringify(notes, null, 1)}\n`);
const count = Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`spec: ${count} operations on ${Object.keys(spec.paths).length} paths -> ${opsFile}`);
console.log(`release notes: ${notes.length} -> ${notesFile}`);
