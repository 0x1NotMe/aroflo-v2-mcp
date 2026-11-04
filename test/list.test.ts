import { describe, expect, it } from 'vitest';
import { ApiCatalog } from '../src/catalog.js';
import { AroFloHttp } from '../src/http.js';
import { fetchList } from '../src/list.js';
import { fakeFetch, noSleep, pagedList, testConfig } from './helpers.js';

const catalog = ApiCatalog.load();
const tasks = catalog.get('GET /tasks')!;
const rows = Array.from({ length: 260 }, (_, i) => ({ id: `T${i + 1}` }));

function setup(handler = pagedList(rows)) {
  const f = fakeFetch({ 'GET /tasks': handler, 'GET /bills': handler, 'GET /tasks/*/materials': handler });
  return { f, http: new AroFloHttp(testConfig(), f.fn, noSleep) };
}

describe('fetchList', () => {
  it('fetches exactly the rows asked for and points at the next page', async () => {
    const { f, http } = setup();
    const r = await fetchList(http, tasks, '/tasks', {}, 25);
    expect(r.items).toHaveLength(25);
    expect(r.total).toBe(260);
    expect(r.next).toEqual({ page: 2, limit: 25 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.query).toEqual({ page: '1', limit: '25' });
  });

  it('pages beyond 100 and gives a next hint that skips nothing', async () => {
    const { f, http } = setup();
    const r = await fetchList(http, tasks, '/tasks', {}, 150);
    expect(r.items).toHaveLength(150);
    expect((r.items.at(-1) as { id: string }).id).toBe('T150');
    expect(r.next).toEqual({ page: 4, limit: 50 });
    expect(f.calls).toHaveLength(2);
    const nextRows = await fetchList(http, tasks, '/tasks', {}, r.next!.limit, r.next!.page);
    expect((nextRows.items[0] as { id: string }).id).toBe('T151');
  });

  it('stops at the end of the data', async () => {
    const { http } = setup();
    const r = await fetchList(http, tasks, '/tasks', {}, 500);
    expect(r.items).toHaveLength(260);
    expect(r.next).toBeUndefined();
  });

  it('caps an explicit page even if AroFlo ignores limit', async () => {
    const { http } = setup(() => ({ body: { items: Array.from({ length: 600 }, (_, i) => ({ id: `X${i}` })) } }));
    const r = await fetchList(http, tasks, '/tasks', {}, 5, 1);
    expect(r.items).toHaveLength(5);
    expect(r.next).toEqual({ page: 2, limit: 5 });
  });

  it('fetches one explicit page', async () => {
    const { f, http } = setup();
    const r = await fetchList(http, tasks, '/tasks', {}, 100, 3);
    expect(r.items).toHaveLength(60);
    expect(r.next).toBeUndefined();
    expect(f.calls).toHaveLength(1);
  });

  it('keeps paging an envelope without a page object while pages come back full', async () => {
    const all = Array.from({ length: 30 }, (_, i) => ({ id: `B${i}` }));
    const { http } = setup((call) => {
      const limit = Number(call.query.limit);
      const page = Number(call.query.page);
      return { body: { count: Math.min(limit, all.length - (page - 1) * limit), items: all.slice((page - 1) * limit, page * limit) } };
    });
    const r = await fetchList(http, catalog.get('GET /bills')!, '/bills', {}, 25);
    expect(r.items).toHaveLength(25);
    expect(r.next).toEqual({ page: 2, limit: 25 });
  });

  it('caps rows at 500 even on endpoints without paging', async () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ id: `M${i}` }));
    const { http } = setup(() => ({ body: { items: many } }));
    const r = await fetchList(http, catalog.get('GET /tasks/{taskId}/materials')!, '/tasks/T1/materials', {}, 1000);
    expect(r.items).toHaveLength(500);
  });

  it('makes one call for endpoints without paging', async () => {
    const { f, http } = setup(() => ({ body: { items: [{ id: 'M1' }, { id: 'M2' }, { id: 'M3' }] } }));
    const r = await fetchList(http, catalog.get('GET /tasks/{taskId}/materials')!, '/tasks/T1/materials', {}, 2);
    expect(r.items).toHaveLength(2);
    expect(f.calls).toHaveLength(1);
  });
});
