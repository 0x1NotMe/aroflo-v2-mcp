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
  'GET /tasks/T50/notes': () => ({ body: [{ note: 'Older note', timestampCreated: '2026-10-01T08:00:00Z' }, { note: '<p>Gate code&nbsp;1234</p>', timestampCreated: '2026-10-02T09:00:00Z' }] }),
  'GET /quotes/Q10': () => ({
    body: { id: 'Q10', jobNumber: 3030, name: 'Back yard', status: 'In Progress', acceptanceStatus: { id: 2, name: 'Awaiting Decision' }, client: { id: 'C1', name: 'Smith, Jo' }, counts: { total: 9900, tax: 900, taxInclusive: true, forms: 3, documents: 2 } }
  }),
  'GET /quotes/Q10/takeoffs': () => ({ body: { count: 1, page: { number: 1, size: 100, count: 1 }, items: [{ id: 'K1', name: 'HARDSCAPES', breakdown: { totalInc: 9900, totalLabourHours: 30 }, _links: {} }] } }),
  'GET /quotes/Q10/lineitems': (call) => pagedList(call.query.takeoffId === 'K1' || !call.query.takeoffId ? lines : [])(call),
  'PATCH /clients/C1': (call) => ({ body: { id: 'C1', name: 'Smith, Jo', individual: (call.body as { individual?: boolean }).individual } }),
  'POST /tasks/T50/notes/bulk': () => ({ status: 207, body: { items: [{ index: 0, status: 201, id: 'N1' }, { index: 1, status: 400, error: 'content required' }] } })
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
    expect(r.text).toContain('notes (latest 2 of 2):\n2026-10-02 09:00Z: Gate code 1234');
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

describe('aroflo_write', () => {
  const writable = () => {
    const dir = mkdtempSync(join(tmpdir(), 'aroflo-audit-'));
    const auditLog = join(dir, 'state', 'audit.jsonl');
    return { ...setup({ writeOps: ['Clients', 'Notes'], auditLog }), auditLog };
  };

  it('is not offered on a read-only server', () => {
    expect(setup().tools.map((t) => t.def.name)).not.toContain('aroflo_write');
  });

  it('previews, then sends exactly once with the code, and audits ids only', async () => {
    const { call, f, auditLog } = writable();
    const args = { method: 'PATCH', path: '/clients/C1', body: { individual: true } };
    const preview = await call('aroflo_write', args);
    expect(preview.text).toMatch(/^PREVIEW, nothing sent: PATCH \/clients\/C1/);
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    const code = /confirm="([0-9a-f]+)"/.exec(preview.text)![1]!;

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

  it('refuses a code from a different payload', async () => {
    const { call } = writable();
    const preview = await call('aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: true } });
    const code = /confirm="([0-9a-f]+)"/.exec(preview.text)![1]!;
    const r = await call('aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: false }, confirm: code });
    expect(r.text).toMatch(/for a different request/);
  });

  it('rejects undocumented fields and operations that are not enabled, before any call', async () => {
    const { call, f } = writable();
    const r = await call('aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: true, colour: 'blue' } });
    expect(r.text).toContain('body has an undocumented field "colour"');
    const q = await call('aroflo_write', { method: 'POST', path: '/quotes', body: {} });
    expect(q.text).toMatch(/POST \/quotes is not enabled on this server. Enabled: Clients, Notes/);
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('reports a 207 partial success', async () => {
    const { call } = writable();
    const args = { method: 'POST', path: '/tasks/T50/notes/bulk', body: { taskNotes: [{ content: 'a', filter: 'INTERNAL_ONLY' }, { content: 'b', filter: 'INTERNAL_ONLY' }] } };
    const code = /confirm="([0-9a-f]+)"/.exec((await call('aroflo_write', args)).text)![1]!;
    const r = await call('aroflo_write', { ...args, confirm: code });
    expect(r.text).toMatch(/-> 207/);
    expect(r.text).toMatch(/some items failed/);
  });
});
