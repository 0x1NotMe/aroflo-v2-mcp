import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { makeDeps } from '../src/deps.js';
import { AroFloHttp } from '../src/http.js';
import { callTool, toolsFor } from '../src/server.js';
import { type Call, fakeFetch, noSleep, pagedList, type Reply, testConfig, TOKEN } from './helpers.js';

// Synthetic data only: no real AroFlo records.
const tasks = Array.from({ length: 250 }, (_, i) => ({ id: `T${i}`, jobNumber: 1000 + i * 2, name: `Job ${i}`, status: 'In Progress', client: { id: `C${i}`, name: `Client ${i}` } }));
const quotes = Array.from({ length: 120 }, (_, i) => ({ id: `Q${i}`, jobNumber: 3000 + i * 3, name: `Quote ${i}`, status: 'In Progress', clientId: `C${i}` }));

function sortedTasks(call: Call): Reply {
  const rows = call.query.sortBy === 'jobnumber' ? [...tasks].sort((a, b) => a.jobNumber - b.jobNumber) : tasks;
  return pagedList(rows)(call);
}

const lines = [
  { item: 'Retaining wall', type: 'MATERIAL', quantity: 1, uom: 'ea', unitSell: 5000, lineTotal: 5000, isOptional: false, isAssembly: true, parentId: null },
  { item: 'Sandstone block', type: 'MATERIAL', quantity: 40, uom: 'ea', unitSell: 100, lineTotal: 4000, isOptional: false, isAssembly: false, parentId: 11 },
  { item: 'Lighting', type: 'MATERIAL', quantity: 1, uom: 'ea', unitSell: 900, lineTotal: 900, isOptional: true, isAssembly: false, parentId: null }
];

const routes: Record<string, (call: Call) => Reply> = {
  'GET /businessunits': () => ({ body: { count: 1, page: { number: 1, size: 1, count: 1 }, items: [{ id: 'BU1' }] } }),
  'GET /tasks': sortedTasks,
  'GET /quotes': pagedList(quotes),
  'GET /clients': (call) => ({ body: { count: 2, page: { number: 1, size: Number(call.query.limit), count: 1 }, items: [{ id: 'C1', name: 'Smith, Jo', individual: true, _links: { api: '/clients/C1' } }, { id: 'C2', name: 'Lee Pty Ltd', individual: false }] } }),
  'GET /tasks/T50': () => ({
    body: { id: 'T50', jobNumber: 1100, name: 'Front garden', status: 'In Progress', client: { id: 'C1', name: 'Smith, Jo', _links: {} }, description: '<p>Build the wall</p>', resources: [{ id: 'U1', name: 'Tom B' }] }
  }),
  'GET /tasks/T50/labours': pagedList([
    { date: '2026-10-01T00:00:00Z', hours: 8, user: { id: 'U1', givenName: 'Tom', familyName: 'B' }, workType: { id: 'W1', name: 'Labour' } },
    { date: '2026-10-02T00:00:00Z', hours: 6.5, user: { id: 'U2', givenName: 'Ann', familyName: 'K' }, workType: { id: 'W1', name: 'Labour' } },
    { date: '2026-10-03T00:00:00Z', hours: 1.5, user: { id: 'U1', givenName: 'Tom', familyName: 'B' }, workType: { id: 'W2', name: 'Travel' } }
  ]),
  'GET /tasks/T50/materials': () => ({ status: 403, body: { error: 'Forbidden' } }),
  // Documented shape: {count, items: [{note: {content, postedBy}, timestampCreated}]}
  'GET /tasks/T50/notes': () => ({
    body: {
      count: 2,
      items: [
        { id: 'N1', note: { id: 'N1', content: 'Older note', postedBy: { id: 'U1', givenName: 'Tom', familyName: 'B' } }, timestampCreated: '2026-10-01T08:00:00Z' },
        { id: 'N2', note: { id: 'N2', content: '<p>Gate code&nbsp;1234</p>', postedBy: { id: 'U2', givenName: 'Ann', familyName: 'K' } }, timestampCreated: '2026-10-02T09:00:00Z' }
      ]
    }
  }),
  'GET /tasks/T60/notes': () => ({ body: Array.from({ length: 600 }, (_, i) => ({ id: `N${i}`, note: `n${i}` })) }),
  'GET /tasks/T61/notes': () => ({ body: { _links: { self: '/x' }, items: Array.from({ length: 600 }, (_, i) => ({ id: `N${i}`, note: `n${i}` })) } }),
  'GET /tasks/T1/assets': (call) => pagedList(Array.from({ length: 12 }, (_, i) => ({ id: `A${i}`, name: `Asset ${i}` })))(call),
  'GET /quotes/Q10': () => ({
    body: { id: 'Q10', jobNumber: 3030, name: 'Back yard', status: 'In Progress', acceptanceStatus: { id: 2, name: 'Awaiting Decision' }, client: { id: 'C1', name: 'Smith, Jo' }, counts: { total: 9900, tax: 900, taxInclusive: true, forms: 3, documents: 2 } }
  }),
  'GET /quotes/Q10/takeoffs': () => ({ body: { count: 1, page: { number: 1, size: 100, count: 1 }, items: [{ id: 'K1', name: 'HARDSCAPES', breakdown: { totalInc: 9900, totalLabourHours: 30 }, _links: {} }] } }),
  'GET /quotes/Q10/lineitems': (call) => pagedList(call.query.takeoffId === 'K1' || !call.query.takeoffId ? lines : [])(call),
  'PATCH /clients/C1': (call) => ({ body: { id: 'C1', name: 'Smith, Jo', individual: (call.body as { individual?: boolean }).individual } }),
  'POST /tasks/T50/notes/bulk': () => ({ status: 207, body: { items: [{ index: 0, status: 201, id: 'N1' }, { index: 1, status: 400, error: 'content required' }] } }),
  'POST /tasks/T51/notes/bulk': () => ({ status: 207, body: { items: [...Array.from({ length: 30 }, (_, i) => ({ index: i, status: 201, id: `N${i}` })), { index: 30, status: 400, error: 'too long' }] } }),
  'POST /tasks/T52/notes/bulk': () => ({
    status: 207,
    body: { items: Array.from({ length: 40 }, (_, i) => ({ id: `N${i}` })), errors: [{ itemIndex: 41, error: { statusCode: 400, message: 'Invalid filter provided' }, originalData: { content: 'x'.repeat(5000) } }] }
  }),
  'GET /tasks/T70': () => ({ body: { id: 'T70', big: { nested: { blob: 'x'.repeat(200_000) } } } })
};

function setup(cfg: Partial<Config> = {}) {
  const f = fakeFetch(routes);
  const config = testConfig(cfg);
  const deps = makeDeps(config, new AroFloHttp(config, f.fn, noSleep));
  const tools = toolsFor(config);
  const call = (name: string, args: Record<string, unknown>) => callTool(tools, name, args, deps);
  return { f, call, tools };
}

describe('aroflo_get', () => {
  it('returns a header line and a table, without _links', async () => {
    const { call } = setup();
    const r = await call('aroflo_get', { path: '/clients?name.like=smith' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe('2 rows\nid\tname\tindividual\nC1\tSmith, Jo\ttrue\nC2\tLee Pty Ltd\tfalse');
  });

  it('applies default columns and honours limit and page', async () => {
    const { call, f } = setup();
    const r = await call('aroflo_get', { path: '/tasks?limit=3' });
    expect(r.text.split('\n')[0]).toBe('3 of 250 rows; next: page=2&limit=3');
    expect(f.calls.at(-1)!.query._fields).toBe('id,jobNumber,name,status,substatus,taskType,client,location,dueDate,requestedDateTime');
    const p = await call('aroflo_get', { path: '/tasks?page=2&limit=3' });
    expect(p.text).toMatch(/^T3\t1006\t/m);
  });

  it('applies default columns locally where AroFlo has no _fields', async () => {
    const f = fakeFetch({ 'GET /projects': () => ({ body: { count: 1, page: { number: 1, size: 25, count: 1 }, items: [{ id: 'P1', name: 'Pool', projectNumber: 7, referenceNumber: 'R-1', customerOrderNumber: 'PO-9' }] } }) });
    const cfg = testConfig();
    const r = await callTool(toolsFor(cfg), 'aroflo_get', { path: '/projects' }, makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)));
    expect(r.text).toBe('1 row\nid\tprojectNumber\tname\nP1\t7\tPool');
    expect(f.calls[0]!.query._fields).toBeUndefined();
  });

  it('adds a hint only when the call uses a parameter with known quirks', async () => {
    const { call } = setup();
    expect((await call('aroflo_get', { path: '/tasks?requiredByFrom=2026-11-05&requiredByTo=2026-11-05&limit=2' })).text).toMatch(/\nhint: requiredByTo=D stops at D 00:00/);
    expect((await call('aroflo_get', { path: '/tasks?limit=2' })).text).not.toContain('hint:');
  });

  it('takes limit on lists AroFlo does not page, and bounds raw array responses', async () => {
    const { call } = setup();
    const m = await call('aroflo_get', { path: '/tasks/T50/labours?limit=2' });
    expect(m.text.split('\n')[0]).toBe('2 of 3 rows; next: page=2&limit=2');
    const n = await call('aroflo_get', { path: '/tasks/T60/notes' });
    expect(n.text.split('\n')[0]).toBe('25 of 600 rows (limit=N for more)');
    expect(n.text.split('\n')).toHaveLength(27);
  });

  it('pages endpoints that page even when the spec does not call them lists', async () => {
    const { call, f } = setup();
    const r = await call('aroflo_get', { path: '/tasks/T1/assets?page=2&limit=5' });
    expect(f.calls.at(-1)!.query).toMatchObject({ page: '2', limit: '5' });
    expect(r.text).toMatch(/^A5\t/m);
  });

  it('bounds an items envelope that carries other keys too', async () => {
    const { call } = setup();
    const r = await call('aroflo_get', { path: '/tasks/T61/notes?limit=2' });
    expect(r.text.split('\n')[0]).toBe('2 of 600 rows (limit=N for more)');
    expect(r.text.split('\n')).toHaveLength(4);
  });

  it('keeps errors short too, even for an absurd path', async () => {
    const { call } = setup();
    const r = await call('aroflo_get', { path: `/${'x'.repeat(200_000)}` });
    expect(r.isError).toBe(true);
    expect(r.text.length).toBeLessThan(600);
  });

  it('cuts any result at the hard ceiling, full=true included', async () => {
    const { call } = setup();
    const r = await call('aroflo_get', { path: '/tasks/T70', full: true });
    expect(r.text.length).toBeLessThanOrEqual(60_000);
    expect(r.text).toMatch(/\[output cut at 60000 chars of \d+; narrow it/);
  });

  it('full=true drops the default columns', async () => {
    const { call, f } = setup();
    await call('aroflo_get', { path: '/tasks?limit=1', full: true });
    expect(f.calls.at(-1)!.query._fields).toBeUndefined();
  });

  it('renders a record and turns validation problems into short errors', async () => {
    const { call, f } = setup();
    expect((await call('aroflo_get', { path: '/tasks/T50' })).text).toContain('client: Smith, Jo [C1]');
    const bad = await call('aroflo_get', { path: '/quotes?status=open' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^GET \/quotes has no filter "status"/);
    expect(f.calls.some((c) => c.path === '/quotes')).toBe(false);
  });

  it('never shows the token in an error', async () => {
    const f = fakeFetch({ 'GET /clients': { status: 500, body: { error: `boom ${TOKEN}` } } });
    const cfg = testConfig();
    const deps = makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep));
    const r = await callTool(toolsFor(cfg), 'aroflo_get', { path: '/clients' }, deps);
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain(TOKEN);
  });
});

describe('aroflo_api', () => {
  it('lists only readable endpoints on a read-only server', async () => {
    const { call } = setup();
    const r = await call('aroflo_api', { q: 'create quote line items' });
    expect(r.text).not.toMatch(/^POST /m);
    expect(r.text).toContain('(This server is read-only.)');
  });

  it('describes one endpoint with required params and default fields', async () => {
    const { call } = setup();
    const r = await call('aroflo_api', { q: 'GET /timesheets/entries' });
    expect(r.text).toMatch(/subzone\* \(TASK_TIMESHEETS\|OVERHEAD_TIMESHEETS\|EXPENSE_TIMESHEETS\)/);
    expect(r.text).toContain('default fields: id,date,hours,user,workType,trackingCentre,note');
  });

  it('shows body fields for a write endpoint and says when it is not enabled', async () => {
    const { call } = setup();
    const r = await call('aroflo_api', { q: 'POST /quotes/{quoteId}/lineitems' });
    expect(r.text).toContain('(writes to this endpoint are not enabled on this server)');
    expect(r.text).toMatch(/takeoffId \(string/);
  });
});

describe('aroflo_job', () => {
  it('finds a job by number and summarises labour, notes and failed parts', async () => {
    const { call, f } = setup();
    const r = await call('aroflo_job', { job: '1100' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('name: Front garden');
    expect(r.text).toContain('labour: 16 h in 3 entries, 2026-10-01 to 2026-10-03');
    expect(r.text).toContain('by person: Tom B 9.5, Ann K 6.5');
    expect(r.text).toContain('by work type: Labour 14.5, Travel 1.5');
    expect(r.text).toMatch(/materials: unavailable \(403: Forbidden/);
    expect(r.text).toContain('notes (latest 2 of 2):\n2026-10-02 09:00Z Ann K: Gate code 1234\n2026-10-01 08:00Z Tom B: Older note');
    const lookups = f.calls.filter((c) => c.path === '/tasks');
    expect(lookups.length).toBeLessThanOrEqual(4);
  });

  it('says plainly when a job number does not exist', async () => {
    const { call } = setup();
    expect((await call('aroflo_job', { job: '1101' })).text).toBe('No job with job number 1101.');
    expect((await call('aroflo_job', { job: '99999' })).text).toBe('No job with job number 99999.');
  });
});

describe('aroflo_quote', () => {
  it('summarises header, money totals, sections and top-level lines', async () => {
    const { call } = setup();
    const r = await call('aroflo_quote', { quote: '3030' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('acceptanceStatus: Awaiting Decision');
    expect(r.text).toContain('totals: total 9900, tax 900, taxInclusive true');
    expect(r.text).not.toContain('forms');
    expect(r.text).toContain('sections (1):\nid\tname\ttotalInc\tlabourHours\nK1\tHARDSCAPES\t9900\t30');
    expect(r.text).toContain('lines: 2 top-level of 3 (lines=true lists all)');
    expect(r.text).not.toContain('Sandstone');
  });

  it('lines=true lists every line by section, children marked', async () => {
    const { call } = setup();
    const r = await call('aroflo_quote', { quote: 'Q10', lines: true });
    expect(r.text).toContain('## HARDSCAPES (3 lines)');
    expect(r.text).toContain('- Sandstone block');
    expect(r.text).toMatch(/Lighting.*\tyes$/m);
  });
});

describe('aroflo_write (code mode: client without confirm dialogs)', () => {
  const writable = () => {
    const dir = mkdtempSync(join(tmpdir(), 'aroflo-audit-'));
    const auditLog = join(dir, 'state', 'audit.jsonl');
    return { ...setup({ writeOps: ['Clients', 'Notes'], auditLog }), auditLog };
  };
  const codeIn = (text: string) => /confirm="([0-9a-f]+)"/.exec(text)![1]!;

  it('is not offered on a read-only server', () => {
    expect(setup().tools.map((t) => t.def.name)).not.toContain('aroflo_write');
  });

  it('previews, then sends exactly once with the code, and audits ids only', async () => {
    const { call, f, auditLog } = writable();
    const args = { method: 'PATCH', path: '/clients/C1', body: { individual: true } };
    const preview = await call('aroflo_write', args);
    expect(preview.text).toMatch(/^PREVIEW, nothing sent:\nPATCH \/clients\/C1\nbody: \{"individual":true\}/);
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    const code = codeIn(preview.text);

    const sent = await call('aroflo_write', { ...args, confirm: code });
    expect(sent.text).toMatch(/^sent: PATCH \/clients\/\{clientId\} -> 200/);
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);

    const again = await call('aroflo_write', { ...args, confirm: code });
    expect(again.text).toMatch(/expired or was already used/);
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);

    const log = readFileSync(auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ op: 'PATCH /clients/{clientId}', path: '/clients/C1', status: 200, outcome: 'ok', ids: ['C1'] });
    expect(JSON.stringify(log[0])).not.toContain('Smith');
    expect(statSync(auditLog).mode & 0o777).toBe(0o600);
  });

  it('gives every preview a fresh code, so a used code never comes back', async () => {
    const { call, f } = writable();
    const args = { method: 'PATCH', path: '/clients/C1', body: { individual: true } };
    const first = codeIn((await call('aroflo_write', args)).text);
    await call('aroflo_write', { ...args, confirm: first });
    const second = codeIn((await call('aroflo_write', args)).text);
    expect(second).not.toBe(first);
    expect((await call('aroflo_write', { ...args, confirm: first })).text).toMatch(/expired or was already used/);
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('refuses a code from a different payload', async () => {
    const { call } = writable();
    const code = codeIn((await call('aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: true } })).text);
    const r = await call('aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: false }, confirm: code });
    expect(r.text).toMatch(/for a different request/);
  });

  it('shows the whole body in the preview, however long', async () => {
    const { call } = writable();
    const body = { taskNotes: [{ content: 'x'.repeat(5000), filter: 'SHOW_CLIENT' }] };
    const r = await call('aroflo_write', { method: 'POST', path: '/tasks/T50/notes/bulk', body });
    expect(r.text).toContain(JSON.stringify(body));
  });

  it('rejects undocumented fields, non-id path values and operations that are not enabled, before any call', async () => {
    const { call, f } = writable();
    expect((await call('aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: true, colour: 'blue' } })).text).toContain('body has an undocumented field "colour"');
    expect((await call('aroflo_write', { method: 'PATCH', path: '/clients/jo%40example.com', body: { individual: true } })).text).toMatch(/clientId must be an AroFlo id/);
    expect((await call('aroflo_write', { method: 'POST', path: '/quotes', body: {} })).text).toMatch(/POST \/quotes is not enabled on this server. Enabled: Clients, Notes/);
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('reports a 207 partial success', async () => {
    const { call } = writable();
    const args = { method: 'POST', path: '/tasks/T50/notes/bulk', body: { taskNotes: [{ content: 'a', filter: 'INTERNAL_ONLY' }, { content: 'b', filter: 'INTERNAL_ONLY' }] } };
    const r = await call('aroflo_write', { ...args, confirm: codeIn((await call('aroflo_write', args)).text) });
    expect(r.text).toMatch(/-> 207/);
    expect(r.text).toContain('207: 1 of 2 items failed; the other 1 succeeded.');
  });

  it("reads AroFlo's documented 207 shape: errors[] next to items[]", async () => {
    const { call } = writable();
    const args = { method: 'POST', path: '/tasks/T52/notes/bulk', body: { taskNotes: [{ content: 'a', filter: 'INTERNAL_ONLY' }] } };
    const r = await call('aroflo_write', { ...args, confirm: codeIn((await call('aroflo_write', args)).text) });
    expect(r.text).toContain('207: 1 item failed, 40 succeeded.');
    expect(r.text).toContain('item 41: 400 Invalid filter provided');
    expect(r.text).not.toContain('xxxxx');
  });

  it('names a 207 failure even when it comes after many successes', async () => {
    const { call } = writable();
    const args = { method: 'POST', path: '/tasks/T51/notes/bulk', body: { taskNotes: [{ content: 'a', filter: 'INTERNAL_ONLY' }] } };
    const r = await call('aroflo_write', { ...args, confirm: codeIn((await call('aroflo_write', args)).text) });
    expect(r.text).toContain('207: 1 of 31 items failed');
    expect(r.text).toContain('too long');
  });
});

describe('aroflo_write (dialog mode: client with MCP elicitation, e.g. Codex)', () => {
  function dialogSetup(answer: boolean) {
    const f = fakeFetch(routes);
    const cfg = testConfig({ writeOps: ['Clients'] });
    const asked: string[] = [];
    const deps = { ...makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)), askUser: async (m: string) => (asked.push(m), answer) };
    const tools = toolsFor(cfg, 'dialog');
    return { f, asked, tools, call: (args: Record<string, unknown>) => callTool(tools, 'aroflo_write', args, deps) };
  }

  it('has no confirm parameter: the user answers a dialog the model cannot see', () => {
    const def = dialogSetup(true).tools.find((t) => t.def.name === 'aroflo_write')!.def;
    expect(Object.keys(def.inputSchema.properties)).toEqual(['method', 'path', 'body']);
  });

  it('sends only after the user accepts, showing the exact request', async () => {
    const yes = dialogSetup(true);
    expect((await yes.call({ method: 'PATCH', path: '/clients/C1', body: { individual: true } })).text).toMatch(/^sent: /);
    expect(yes.asked[0]).toContain('PATCH /clients/C1');
    expect(yes.asked[0]).toContain('"individual": true');
    const no = dialogSetup(false);
    expect((await no.call({ method: 'PATCH', path: '/clients/C1', body: { individual: true } })).text).toBe('Not sent: the user declined.');
    expect(no.f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('sends nothing when the client cancels the call before the write goes out', async () => {
    const f = fakeFetch(routes);
    const cfg = testConfig({ writeOps: ['Clients'] });
    const ac = new AbortController();
    const deps = { ...makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)), askUser: async () => (ac.abort(), true), signal: ac.signal };
    const r = await callTool(toolsFor(cfg, 'dialog'), 'aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: true } }, deps);
    expect(r.text).toBe('Cancelled: nothing was sent.');
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});

describe('composite safety and size', () => {
  it('stops a composite on a rejected token instead of carrying on', async () => {
    const f = fakeFetch({ ...routes, 'GET /quotes/Q10/takeoffs': () => ({ status: 401, body: { error: 'Unauthorized' } }) });
    const cfg = testConfig();
    const r = await callTool(toolsFor(cfg), 'aroflo_quote', { quote: 'Q10' }, makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^401: AroFlo rejected the token/);
    expect(f.calls.some((c) => c.path.endsWith('/lineitems'))).toBe(false);
  });

  it('caps materials on a big job and says how to get the rest', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ itemName: `Item ${i}`, quantity: i, sell: i * 2 }));
    const f = fakeFetch({ ...routes, 'GET /tasks/T50/materials': () => ({ body: { items: many } }) });
    const cfg = testConfig();
    const r = await callTool(toolsFor(cfg), 'aroflo_job', { job: 'T50' }, makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)));
    expect(r.text).toContain('materials (80, first 25; all: aroflo_get /tasks/T50/materials?limit=80):');
    expect(r.text).not.toContain('Item 25\t');
  });
});

describe('arguments', () => {
  it('reads booleans strictly', async () => {
    const { call } = setup();
    expect((await call('aroflo_quote', { quote: 'Q10', lines: 'TRUE' })).text).toContain('## HARDSCAPES');
    expect((await call('aroflo_quote', { quote: 'Q10', lines: 1 })).text).toContain('## HARDSCAPES');
    expect((await call('aroflo_quote', { quote: 'Q10', lines: 'maybe' })).text).toBe('lines must be true or false.');
  });
});
