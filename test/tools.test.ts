import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { makeDeps } from '../src/deps.js';
import { AroFloHttp } from '../src/http.js';
import { callTool, toolsFor } from '../src/server.js';
import type { DialogAnswer } from '../src/tools/types.js';
import { type Call, fakeFetch, noSleep, pagedList, type Reply, testConfig, TOKEN } from './helpers.js';

// Synthetic data only: no real AroFlo records.
const tasks = Array.from({ length: 250 }, (_, i) => ({ id: `T${i}`, jobNumber: 1000 + i * 2, name: `Job ${i}`, status: 'In Progress', client: { id: `C${i}`, name: `Client ${i}` } }));
const quotes = Array.from({ length: 120 }, (_, i) => ({ id: `Q${i}`, jobNumber: 3000 + i * 3, name: `Quote ${i}`, status: 'In Progress', clientId: `C${i}` }));

function sortedTasks(call: Call): Reply {
  const rows = call.query.sortBy === 'jobnumber' ? [...tasks].sort((a, b) => a.jobNumber - b.jobNumber) : tasks;
  return pagedList(rows)(call);
}

// labourQuantity = hours per unit. The component's quantity is per unit of its assembly (2 walls x 15 h = 30 h).
const lines = [
  { item: 'Retaining wall', type: 'MATERIAL', quantity: 2, uom: 'ea', unitSell: 2500, lineTotal: 5000, labourQuantity: 15, isOptional: false, isAssembly: true, parentId: null },
  { item: 'Sandstone block', type: 'MATERIAL', quantity: 20, uom: 'ea', unitSell: 100, lineTotal: 2000, labourQuantity: 0.75, isOptional: false, isAssembly: false, parentId: 11 },
  { item: 'Lighting', type: 'MATERIAL', quantity: 1, uom: 'ea', unitSell: 900, lineTotal: 900, labourQuantity: 0, isOptional: true, isAssembly: false, parentId: null }
];

/** Rows of every table in `text` that has a `col` column, as [first cell, `col` cell]. A table's header is the first tab line after a line without tabs. */
function column(text: string, col: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let at = -1;
  let inTable = false;
  for (const line of text.split('\n')) {
    const cells = line.split('\t');
    const tabbed = cells.length > 1;
    if (tabbed && !inTable) at = cells.indexOf(col);
    else if (tabbed && at >= 0) out.push([cells[0]!, cells[at] ?? '']);
    inTable = tabbed;
  }
  return out;
}

/** The `col` cell of the single row whose first cell is `key`. */
function cellOf(text: string, col: string, key: string): string {
  const hits = column(text, col).filter(([k]) => k === key);
  expect(hits, `rows starting "${key}"`).toHaveLength(1);
  return hits[0]![1];
}

const routes: Record<string, (call: Call) => Reply> = {
  'GET /businessunits': () => ({ body: { count: 1, page: { number: 1, size: 1, count: 1 }, items: [{ id: 'BU1' }] } }),
  'GET /tasks': sortedTasks,
  'GET /quotes': pagedList(quotes),
  'GET /timesheets/entries': pagedList([
    { id: 'E1', date: '2026-10-01', hours: 8, user: { id: 'U1', givenName: 'Tom', familyName: 'B' } },
    { id: 'E2', date: '2026-10-01', hours: 7.5, user: { id: 'U2', givenName: 'Ann', familyName: 'K' } }
  ]),
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
    const r = await call('aroflo_get', { path: '/clients?name.like=smith&archived=false' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe('2 rows\nid\tname\tindividual\nC1\tSmith, Jo\ttrue\nC2\tLee Pty Ltd\tfalse');
  });

  it('says a client list includes archived clients unless archived is set', async () => {
    const { call } = setup();
    expect((await call('aroflo_get', { path: '/clients?name.like=smith' })).text).toMatch(
      /\nhint: This list includes archived clients, and rows carry no status\. archived=false lists active clients only, archived=true archived only\.$/
    );
    expect((await call('aroflo_get', { path: '/clients?archived=true' })).text).not.toContain('hint:');
  });

  it("refuses a page size above AroFlo's 100 and says how to get more rows", async () => {
    const { call, f } = setup();
    const paged = await call('aroflo_get', { path: '/clients?page=1&limit=500' });
    expect(paged.isError).toBe(true);
    expect(paged.text).toBe('limit must be a whole number from 1 to 100. With page=N, limit is rows per page and AroFlo allows at most 100. Leave out page to get up to 500 rows in one call.');
    const big = await call('aroflo_get', { path: '/clients?limit=501' });
    expect(big.isError).toBe(true);
    expect(big.text).toBe('limit must be a whole number from 1 to 500. For more rows, call again with the page and limit after "next:" in the first line of the result.');
    // An endpoint AroFlo doesn't page has no next page to point at.
    const unpaged = await call('aroflo_get', { path: '/tasks/T1/materials?limit=501' });
    expect(unpaged.isError).toBe(true);
    expect(unpaged.text).toBe('limit must be a whole number from 1 to 500. AroFlo returns this list in one response, so 500 rows is the most one call shows. Narrow it with a filter.');
    expect(f.calls).toHaveLength(0);
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

  it('warns when a timesheet query leaves out endDate, because AroFlo then returns one day', async () => {
    const { call } = setup();
    const day = await call('aroflo_get', { path: '/timesheets/entries?subzone=TASK_TIMESHEETS&entryDate=2026-10-01' });
    expect(day.text).toMatch(/\nhint: Without endDate you get one day only: endDate defaults to entryDate\.$/);
    expect(day.text).not.toContain('Rows carry no task');
    const month = await call('aroflo_get', { path: '/timesheets/entries?subzone=TASK_TIMESHEETS&entryDate=2026-10-01&endDate=2026-10-31' });
    expect(month.text).not.toContain('hint:');
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

  it('shows the text of task notes, not the id of the nested note', async () => {
    const { call } = setup();
    const r = await call('aroflo_get', { path: '/tasks/T50/notes' });
    expect(r.text).toContain('Gate code 1234');
    expect(r.text).toContain('Older note');
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
    expect(r.text).toContain('hint: Without endDate you get one day only');
    expect(r.text).toContain('hint: Rows carry no task. For one job add taskId=');
  });

  it('explains limit and page as rows, and says clients have no created date', async () => {
    const { call } = setup();
    const r = await call('aroflo_api', { q: 'GET /clients' });
    expect(r.text).toContain("rows: 25 by default. limit=N gives up to 500, or page=N with limit up to 100 gives one page. The result's first line shows the total when AroFlo gives one, and next: when more rows may follow.");
    expect(r.text).not.toMatch(/^ {2}(page|limit) \(/m);
    expect(r.text).toContain('hint: This list includes archived clients');
    expect(r.text).toContain("hint: Clients have no created date in API v2: no field in lists or records, and no date filter. Say so; don't infer one from notes, jobs or ids.");
  });

  it('names the task-type filter, which the spec calls a service id', async () => {
    const { call } = setup();
    expect((await call('aroflo_api', { q: 'GET /tasks' })).text).toContain('hint: serviceId=<id from /types/tasks> filters by task type.');
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
    expect(r.text).toContain('totals: total 9900, tax 900, taxInclusive true\nlabour hours: 30\nsections (1):');
    expect(r.text).not.toContain('forms');
    expect(r.text).toContain('sections (1):\nid\tname\ttotalInc\tlabourHours\nK1\tHARDSCAPES\t9900\t30');
    expect(r.text).toContain('lines: 2 top-level of 3 (lines=true lists all)');
    expect(r.text).not.toContain('Sandstone');
    expect(cellOf(r.text, 'labourHours', 'Retaining wall')).toBe('30');
    expect(cellOf(r.text, 'labourHours', 'Lighting')).toBe('');
  });

  it('lines=true lists every line by section, children marked, hours on top-level lines only', async () => {
    const { call } = setup();
    const r = await call('aroflo_quote', { quote: 'Q10', lines: true });
    expect(r.text).toContain('## HARDSCAPES (3 lines)');
    expect(r.text).toContain('- Sandstone block');
    expect(r.text).toMatch(/Lighting.*\tyes$/m);
    expect(cellOf(r.text, 'labourHours', 'Retaining wall')).toBe('30');
    expect(cellOf(r.text, 'labourHours', '- Sandstone block')).toBe('');
  });

  const quoteWith = async (extra: Record<string, (call: Call) => Reply>) => {
    const f = fakeFetch({ ...routes, ...extra });
    const cfg = testConfig();
    return callTool(toolsFor(cfg), 'aroflo_quote', { quote: 'Q10' }, makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)));
  };

  it('labels the labour hours partial when a section has none, and reads line hours from strings and credits', async () => {
    const r = await quoteWith({
      'GET /quotes/Q10/takeoffs': pagedList([
        { id: 'K1', name: 'HARDSCAPES', breakdown: { totalInc: 9900, totalLabourHours: 30 } },
        { id: 'K2', name: 'PLANTING', breakdown: null }
      ]),
      'GET /quotes/Q10/lineitems': pagedList([
        { item: 'Turf', quantity: '4', labourQuantity: '1.5', parentId: null },
        { item: 'Credit paving', quantity: -2, labourQuantity: 3, parentId: null },
        { item: 'Edging', quantity: 3, labourQuantity: 0.333, parentId: null }
      ])
    });
    expect(r.text).toContain('labour hours: 30 (partial: 1 of 2 sections report hours)');
    expect(cellOf(r.text, 'labourHours', 'Turf')).toBe('6');
    expect(cellOf(r.text, 'labourHours', 'Credit paving')).toBe('-6');
    expect(cellOf(r.text, 'labourHours', 'Edging')).toBe('1');
  });

  it('adds labour hours across pages of sections, and says when the section list was cut', async () => {
    const sections = (n: number) => pagedList(Array.from({ length: n }, (_, i) => ({ id: `K${i}`, name: `S${i}`, breakdown: { totalInc: 1, totalLabourHours: 1 } })));
    expect((await quoteWith({ 'GET /quotes/Q10/takeoffs': sections(101) })).text).toMatch(/^labour hours: 101$/m);
    expect((await quoteWith({ 'GET /quotes/Q10/takeoffs': sections(501) })).text).toContain('labour hours: 500 (partial: first 500 sections only)');
  });

  it('leaves out the labour hours line when no section reports hours', async () => {
    const f = fakeFetch({
      ...routes,
      'GET /quotes/Q10/takeoffs': () => ({ body: { count: 1, page: { number: 1, size: 100, count: 1 }, items: [{ id: 'K1', name: 'HARDSCAPES', breakdown: { totalInc: 9900 } }] } })
    });
    const cfg = testConfig();
    const r = await callTool(toolsFor(cfg), 'aroflo_quote', { quote: 'Q10' }, makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)));
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain('labour hours:');
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
  function dialogSetup(answer: DialogAnswer) {
    const f = fakeFetch(routes);
    const cfg = testConfig({ writeOps: ['Clients'] });
    const asked: string[] = [];
    const deps = { ...makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)), askUser: async (m: string) => (asked.push(m), answer) };
    const tools = toolsFor(cfg, 'dialog');
    return { f, asked, tools, call: (args: Record<string, unknown>) => callTool(tools, 'aroflo_write', args, deps) };
  }

  it('has no confirm parameter: the user answers a dialog the model cannot see', () => {
    const def = dialogSetup('send').tools.find((t) => t.def.name === 'aroflo_write')!.def;
    expect(Object.keys(def.inputSchema.properties)).toEqual(['method', 'path', 'body']);
  });

  it('sends only after the user chooses to send, showing the exact request', async () => {
    const yes = dialogSetup('send');
    expect((await yes.call({ method: 'PATCH', path: '/clients/C1', body: { individual: true } })).text).toMatch(/^sent: /);
    expect(yes.asked[0]).toContain('PATCH /clients/C1');
    expect(yes.asked[0]).toContain('"individual": true');
  });

  it.each<[Exclude<DialogAnswer, 'send'>, RegExp]>([
    ['decline', /^Not sent: the confirm dialog came back declined\. If the user saw no dialog, the client declined it by itself .*Don't retry without asking the user\.$/],
    ['kept-false', /^Not sent: the dialog was accepted with "Send to AroFlo" left on False\. If the user meant to send it, call again and they choose True\.$/],
    ['no-choice', /^Not sent: the dialog was accepted without a "Send to AroFlo" choice\. If the user meant to send it, call again and they choose True\.$/],
    ['cancel', /^Not sent: the confirm dialog was closed without an answer\.$/],
    ['timeout', /^Not sent: the confirm dialog got no answer within 10 minutes\.$/]
  ])('sends nothing on %s, and says what happened', async (answer, text) => {
    const s = dialogSetup(answer);
    expect((await s.call({ method: 'PATCH', path: '/clients/C1', body: { individual: true } })).text).toMatch(text);
    expect(s.f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('reports a dialog that fails for another reason, and sends nothing', async () => {
    const f = fakeFetch(routes);
    const cfg = testConfig({ writeOps: ['Clients'] });
    const deps = { ...makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)), askUser: async () => Promise.reject(new Error('no UI')) };
    const r = await callTool(toolsFor(cfg, 'dialog'), 'aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: true } }, deps);
    expect(r.text).toBe('Not sent: the confirm dialog failed (no UI).');
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('sends nothing when the client cancels the call before the write goes out', async () => {
    const f = fakeFetch(routes);
    const cfg = testConfig({ writeOps: ['Clients'] });
    const ac = new AbortController();
    const deps = { ...makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)), askUser: async () => (ac.abort(), 'send' as const), signal: ac.signal };
    const r = await callTool(toolsFor(cfg, 'dialog'), 'aroflo_write', { method: 'PATCH', path: '/clients/C1', body: { individual: true } }, deps);
    expect(r.text).toBe('Cancelled: nothing was sent.');
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('says cancelled, not timed out or failed, when the client cancels while the dialog is open', async () => {
    const f = fakeFetch(routes);
    const cfg = testConfig({ writeOps: ['Clients'] });
    const args = { method: 'PATCH', path: '/clients/C1', body: { individual: true } };
    const run = (askUser: () => Promise<DialogAnswer>, ac: AbortController) =>
      callTool(toolsFor(cfg, 'dialog'), 'aroflo_write', args, { ...makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)), askUser, signal: ac.signal });
    const thrown = new AbortController();
    expect((await run(async () => (thrown.abort(), Promise.reject(new Error('Request timed out'))), thrown)).text).toBe('Cancelled: nothing was sent.');
    const answered = new AbortController();
    expect((await run(async () => (answered.abort(), 'timeout' as const), answered)).text).toBe('Cancelled: nothing was sent.');
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
