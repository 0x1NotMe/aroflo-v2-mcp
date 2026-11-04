import { describe, expect, it } from 'vitest';
import { ApiCatalog } from '../src/catalog.js';
import { buildQuery, fieldNames, resolveTarget, splitPath, UsageError } from '../src/request.js';

const catalog = ApiCatalog.load();
const bu = { businessUnitId: async () => 'BU1' };

describe('splitPath', () => {
  it.each([
    ['/tasks?status=1', '/tasks', 'status=1'],
    ['tasks/', '/tasks', ''],
    ['https://api.aroflo.com/v2/clients?name.like=lee', '/clients', 'name.like=lee'],
    ['/v2/quotes', '/quotes', '']
  ])('%s', (input, path, query) => {
    const r = splitPath(input);
    expect(r.path).toBe(path);
    expect(r.search.toString()).toBe(new URLSearchParams(query).toString());
  });
});

describe('resolveTarget', () => {
  it('fills a business-unit placeholder in the path', async () => {
    const t = await resolveTarget(catalog, 'GET', '/businessunits/{businessUnitId}/inventoryitems?limit=5', bu);
    expect(t.path).toBe('/businessunits/BU1/inventoryitems');
    expect(t.search.get('limit')).toBe('5');
  });
  it.each(['/tasks/../labours', '/tasks/%2E%2E/labours', '/tasks/./labours', '/clients/a%2Fb', '/clients/a%5Cb', '/clients/a%00'])('rejects path tricks: %s', async (input) => {
    await expect(resolveTarget(catalog, 'GET', input, bu)).rejects.toThrow(/Invalid/);
  });
  it('refuses other placeholders', async () => {
    await expect(resolveTarget(catalog, 'GET', '/tasks/{taskId}/labours', bu)).rejects.toThrow(/needs a real taskId/);
  });
  it('explains a wrong method', async () => {
    await expect(resolveTarget(catalog, 'DELETE', '/clients/C1', bu)).rejects.toThrow('DELETE is not available on /clients/C1; it supports GET, PATCH.');
  });
  it('suggests close endpoints for an unknown path', async () => {
    await expect(resolveTarget(catalog, 'GET', '/invoice', bu)).rejects.toThrow(/Close: .*\/invoices/);
  });
});

describe('buildQuery', () => {
  const op = (k: string) => catalog.get(k)!;

  it('rejects an unknown filter and lists the valid ones', async () => {
    await expect(buildQuery(op('GET /quotes'), new URLSearchParams('status=1'), bu)).rejects.toThrow(/has no filter "status". Valid: businessUnitId, page, limit/);
  });
  it('normalises enum case and validates types', async () => {
    const q = await buildQuery(op('GET /timesheets/entries'), new URLSearchParams('subzone=task_timesheets&entryDate=2026-11-01&limit=10'), bu);
    expect(q).toEqual({ subzone: 'TASK_TIMESHEETS', entryDate: '2026-11-01', limit: '10' });
    await expect(buildQuery(op('GET /timesheets/entries'), new URLSearchParams('subzone=TASK_TIMESHEETS&entryDate=1/11/2026'), bu)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(buildQuery(op('GET /tasks'), new URLSearchParams('status=open'), bu)).rejects.toThrow(/status must be a number/);
  });
  it('coerces booleans', async () => {
    expect(await buildQuery(op('GET /clients'), new URLSearchParams('archived=no'), bu)).toEqual({ archived: 'false' });
  });
  it('fills required business-unit parameters', async () => {
    expect(await buildQuery(op('GET /users'), new URLSearchParams(), bu)).toEqual({ orgId: 'BU1' });
    expect(await buildQuery(op('GET /invoices'), new URLSearchParams('allStatus=1'), bu)).toEqual({ allStatus: '1', businessUnitId: 'BU1' });
  });
  it('accepts true/false for 0/1 integer flags', async () => {
    expect((await buildQuery(op('GET /invoices'), new URLSearchParams('allStatus=true'), bu)).allStatus).toBe('1');
  });
  it('treats empty or placeholder business-unit values as the default unit, and drops empty optional filters', async () => {
    expect(await buildQuery(op('GET /users'), new URLSearchParams('orgId='), bu)).toEqual({ orgId: 'BU1' });
    expect(await buildQuery(op('GET /users'), new URLSearchParams('orgId=default'), bu)).toEqual({ orgId: 'BU1' });
    expect(await buildQuery(op('GET /clients'), new URLSearchParams('name.like=&archived=false'), bu)).toEqual({ archived: 'false' });
    await expect(buildQuery(op('GET /schedules'), new URLSearchParams('scheduleZone='), bu)).rejects.toThrow('scheduleZone needs a value.');
  });
  it('names a missing required parameter with its options', async () => {
    await expect(buildQuery(op('GET /schedules'), new URLSearchParams(), bu)).rejects.toThrow(/needs scheduleZone \(one of TASK, USER\)/);
  });
  it('checks _fields against the response fields', async () => {
    expect((await buildQuery(op('GET /clients'), new URLSearchParams('_fields=id, name'), bu))._fields).toBe('id,name');
    await expect(buildQuery(op('GET /clients'), new URLSearchParams('_fields=id,colour'), bu)).rejects.toThrow(/has no field colour/);
  });
  it('throws UsageError, not a generic error', async () => {
    await expect(buildQuery(op('GET /quotes'), new URLSearchParams('nope=1'), bu)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('fieldNames', () => {
  it('splits only at the top level', () => {
    expect(fieldNames('id,client[id,name],status')).toEqual(['id', 'client', 'status']);
  });
});
