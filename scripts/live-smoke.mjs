#!/usr/bin/env node
// Read-only smoke test against live AroFlo through the real tool handlers (needs `npm run build`).
// Prints, per call: tokens, characters and the first line. --show prints full outputs (real data:
// keep it in your terminal, never paste it into the repo).
// usage: AROFLO_V2_API_KEY=... node scripts/live-smoke.mjs [--show]
import { encode } from 'gpt-tokenizer';
import { makeDeps } from '../dist/deps.js';
import { callTool, toolsFor } from '../dist/server.js';

const show = process.argv.includes('--show');
const deps = makeDeps();
if (deps.cfg.writeOps.length) {
  console.error('refusing to run with AROFLO_V2_WRITE_OPS set: the smoke test is read-only');
  process.exit(2);
}
const tools = toolsFor(deps.cfg);
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// Pick a recent job and quote by job number, using the same client the tools use.
const latest = async (path, query) => {
  const r = await deps.http.request('GET', path, { query, collection: true });
  return r.data?.items?.[0]?.jobNumber;
};
const job = await latest('/tasks', { sortBy: 'jobnumber', ascending: 'false', limit: '1', _fields: 'jobNumber' });
const quotes = await deps.http.request('GET', '/quotes', { query: { limit: '1', _fields: 'jobNumber' }, collection: true });
const quotePage = Math.max(1, (quotes.data?.page?.count ?? 1) - 20);
const quote = await latest('/quotes', { limit: '1', page: String(quotePage), _fields: 'jobNumber' });

const calls = [
  ['aroflo_get', { path: '/clients?limit=5' }],
  ['aroflo_get', { path: '/tasks?limit=5&sortBy=jobnumber&ascending=false' }],
  ['aroflo_get', { path: '/quotes?limit=5' }],
  ['aroflo_get', { path: '/users?limit=5' }],
  ['aroflo_get', { path: `/schedules?scheduleZone=USER&currentDate=${day(1)}` }],
  ['aroflo_get', { path: `/timesheets/entries?subzone=TASK_TIMESHEETS&entryDate=${day(-7)}&limit=5` }],
  ['aroflo_get', { path: '/invoices?allStatus=1&limit=5' }],
  ['aroflo_get', { path: '/types/tasks' }],
  ['aroflo_job', { job: String(job) }],
  ['aroflo_quote', { quote: String(quote) }],
  ['aroflo_api', { q: 'timesheets' }],
  ['aroflo_api', { q: 'GET /tasks' }]
];

let total = 0;
for (const [name, args] of calls) {
  const before = deps.http.rate.dailyRemaining;
  const r = await callTool(tools, name, args, deps);
  const tokens = encode(r.text).length;
  total += tokens;
  const used = before !== undefined && deps.http.rate.dailyRemaining !== undefined ? before - deps.http.rate.dailyRemaining : '?';
  console.log(`${r.isError ? 'ERR' : 'ok '} ${name} ${JSON.stringify(args)}  ${tokens} tokens, ${r.text.length} chars, ${used} calls | ${r.text.split('\n')[0].slice(0, 110)}`);
  if (show) console.log(`${r.text}\n`);
}
console.log(`total ${total} tokens for ${calls.length} tool calls; AroFlo calls left today: ${deps.http.rate.dailyRemaining}`);
