import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { toolsFor } from '../src/server.js';
import { testConfig } from './helpers.js';

const load = (env: Record<string, string>) => {
  const warnings: string[] = [];
  const cfg = loadConfig({ AROFLO_V2_API_KEY: 'x', ...env }, (m) => warnings.push(m));
  return { writeOps: cfg.writeOps, warnings };
};

describe('write settings', () => {
  it('turns all writes on by default', () => {
    expect(load({}).writeOps).toEqual(['*']);
  });

  it('turns writes off for AROFLO_V2_READ_ONLY, and treats an unknown value as read-only', () => {
    for (const v of ['1', 'true', 'YES', ' on ', 'maybe']) expect(load({ AROFLO_V2_READ_ONLY: v }).writeOps, v).toEqual([]);
    for (const v of ['', '0', 'false', 'No', 'off']) expect(load({ AROFLO_V2_READ_ONLY: v }).writeOps, v).toEqual(['*']);
  });

  it('limits writes to AROFLO_V2_WRITE_OPS, and an empty value still means none', () => {
    expect(load({ AROFLO_V2_WRITE_OPS: 'Notes, PATCH /clients/{clientId} ,' }).writeOps).toEqual(['Notes', 'PATCH /clients/{clientId}']);
    expect(load({ AROFLO_V2_WRITE_OPS: '' }).writeOps).toEqual([]);
    expect(load({ AROFLO_V2_WRITE_OPS: ' , ' }).writeOps).toEqual([]);
  });

  it('lets read-only win over a write list, and says so', () => {
    const r = load({ AROFLO_V2_READ_ONLY: '1', AROFLO_V2_WRITE_OPS: 'Notes' });
    expect(r.writeOps).toEqual([]);
    expect(r.warnings).toEqual(['ignoring AROFLO_V2_WRITE_OPS: AROFLO_V2_READ_ONLY is set, so writes are off']);
    expect(load({ AROFLO_V2_READ_ONLY: '1' }).warnings).toEqual([]);
  });

  it('describes "all writes" in words in the write tool', () => {
    const write = toolsFor(testConfig({ writeOps: ['*'] })).find((t) => t.def.name === 'aroflo_write');
    expect(write?.def.description).toContain('(enabled: all write endpoints)');
    expect(toolsFor(testConfig({ writeOps: [] })).map((t) => t.def.name)).not.toContain('aroflo_write');
  });
});
