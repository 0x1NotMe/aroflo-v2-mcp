import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { toolsFor } from '../src/server.js';

const load = (env: Record<string, string>) => {
  const warnings: string[] = [];
  const cfg = loadConfig({ AROFLO_V2_API_KEY: 'x', ...env }, (m) => warnings.push(m));
  return { cfg, writeOps: cfg.writeOps, warnings };
};

const toolNames = (env: Record<string, string>, mode: 'dialog' | 'code') => toolsFor(load(env).cfg, mode).map((t) => t.def.name);

describe('write settings', () => {
  it('turns all writes on by default', () => {
    expect(load({}).writeOps).toEqual(['*']);
  });

  it('turns writes off for AROFLO_V2_READ_ONLY, and treats an unknown value as read-only', () => {
    for (const v of ['1', 'true', 'TRUE ', 'YES', ' on ', 'maybe']) expect(load({ AROFLO_V2_READ_ONLY: v }).writeOps, JSON.stringify(v)).toEqual([]);
    for (const v of ['', '   ', '0', '0 ', 'false', 'No', 'off']) expect(load({ AROFLO_V2_READ_ONLY: v }).writeOps, JSON.stringify(v)).toEqual(['*']);
  });

  it('limits writes to AROFLO_V2_WRITE_OPS, and an empty value still means none', () => {
    expect(load({ AROFLO_V2_WRITE_OPS: 'Notes, PATCH /clients/{clientId} ,' }).writeOps).toEqual(['Notes', 'PATCH /clients/{clientId}']);
    expect(load({ AROFLO_V2_WRITE_OPS: '' }).writeOps).toEqual([]);
    expect(load({ AROFLO_V2_WRITE_OPS: ' , ' }).writeOps).toEqual([]);
  });

  it('lets read-only win over a write list, including "*", and says so once', () => {
    for (const list of ['Notes', '*']) {
      const r = load({ AROFLO_V2_READ_ONLY: '1', AROFLO_V2_WRITE_OPS: list });
      expect(r.writeOps).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/AROFLO_V2_WRITE_OPS.*AROFLO_V2_READ_ONLY/);
    }
    expect(load({ AROFLO_V2_READ_ONLY: '1' }).warnings).toEqual([]);
  });

  it('offers aroflo_write by default and hides it read-only, in both confirm modes', () => {
    for (const mode of ['dialog', 'code'] as const) {
      expect(toolNames({}, mode), mode).toContain('aroflo_write');
      expect(toolNames({ AROFLO_V2_READ_ONLY: '1' }, mode), mode).not.toContain('aroflo_write');
      expect(toolNames({ AROFLO_V2_WRITE_OPS: '' }, mode), mode).not.toContain('aroflo_write');
    }
  });

  it('describes "all writes" in words in the write tool', () => {
    for (const mode of ['dialog', 'code'] as const) {
      const write = toolsFor(load({}).cfg, mode).find((t) => t.def.name === 'aroflo_write');
      expect(write?.def.description, mode).toContain('(enabled: all write endpoints)');
    }
  });
});
