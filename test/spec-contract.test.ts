import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiCatalog } from '../src/catalog.js';
import { usedOps } from '../src/defaults.js';

// When AroFlo removes something this server depends on, the weekly spec PR fails here and names it.
const catalog = ApiCatalog.load();
const used = usedOps();

describe('spec contract', () => {
  it('spec/used.json matches the code (regenerate with npm run spec:used)', () => {
    const file = JSON.parse(readFileSync(new URL('../spec/used.json', import.meta.url), 'utf8')).ops;
    expect(file).toEqual(used);
  });

  for (const [key, entries] of Object.entries(used)) {
    it(`${key} still has every field and param we use`, () => {
      const op = catalog.get(key);
      expect(op, `${key} is gone from the spec`).toBeDefined();
      const missing = entries.filter((e) => (e.startsWith('param:') ? !op!.q.some((p) => p.n === e.slice(6)) : !(op!.f ?? []).includes(e)));
      expect(missing).toEqual([]);
    });
  }

  // The GET /clients hints in src/defaults.ts say clients have no created date and no status. When the weekly
  // spec PR fails here, AroFlo has added one: update those hints and consider adding it to the default columns.
  const CREATED_OR_STATUS = /creat|insert|status|archiv/i;
  const DATE_FILTER = /creat|insert|date|since/i;

  it('the client guard catches the names AroFlo uses on other endpoints', () => {
    for (const name of ['createdDate', 'dateCreated', 'timestampCreated', 'datetimeInserted', 'status', 'archived']) expect(name).toMatch(CREATED_OR_STATUS);
    for (const name of ['createdDate.from', 'fromDate', 'since', 'dateInserted']) expect(name).toMatch(DATE_FILTER);
  });

  it('clients still have no created date or status, as the GET /clients hints say', () => {
    for (const key of ['GET /clients', 'GET /clients/{clientId}']) {
      const op = catalog.get(key);
      expect(op, `${key} is gone from the spec`).toBeDefined();
      expect((op!.f ?? []).filter((f) => CREATED_OR_STATUS.test(f)), `${key} fields`).toEqual([]);
      expect(op!.q.map((p) => p.n).filter((n) => DATE_FILTER.test(n)), `${key} filters`).toEqual([]);
    }
  });
});
