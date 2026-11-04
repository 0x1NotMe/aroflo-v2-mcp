import { describe, expect, it } from 'vitest';
import { ApiCatalog } from '../src/catalog.js';

const catalog = ApiCatalog.load();

describe('catalog', () => {
  it('loads every operation', () => {
    expect(catalog.ops.length).toBeGreaterThanOrEqual(140);
    expect(catalog.get('GET /tasks')?.list).toBe(1);
  });

  it('matches concrete paths and keeps id case', () => {
    const m = catalog.match('GET', '/tasks/AbC12/labours');
    expect(m?.op.k).toBe('GET /tasks/{taskId}/labours');
    expect(m?.params).toEqual({ taskId: 'AbC12' });
  });

  it('prefers the template with more literal segments', () => {
    expect(catalog.match('GET', '/quotes/takeoffs/K1')?.op.k).toBe('GET /quotes/takeoffs/{takeoffId}');
    expect(catalog.match('GET', '/quotes/Q1/takeoffs')?.op.k).toBe('GET /quotes/{quoteId}/takeoffs');
  });

  it('is case-insensitive on literal segments', () => {
    expect(catalog.match('GET', '/Tasks')?.op.k).toBe('GET /tasks');
  });

  it('lists the methods a path supports', () => {
    expect(catalog.methodsFor('/clients/C1')).toEqual(['GET', 'PATCH']);
  });

  it('finds endpoints from plain words', () => {
    expect(catalog.search('quote line items').map((o) => o.k)).toContain('GET /quotes/{quoteId}/lineitems');
    expect(catalog.search('create quote')[0]?.k).toBe('POST /quotes');
    expect(catalog.search('timesheets', { methods: ['GET'] })[0]?.k).toBe('GET /timesheets/entries');
    expect(catalog.search('zzzz')).toEqual([]);
  });
});
