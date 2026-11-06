import { encode } from 'gpt-tokenizer';
import { describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../src/config.js';
import { INSTRUCTIONS, toolsFor } from '../src/server.js';
import { testConfig } from './helpers.js';

// Every MCP client sends the tool list to the model on every turn. v1 (aroflo-mcp) cost ~26,000 tokens
// per turn for 51 tools; these caps keep v2 near 500 read-only and 700 with writes, which is the default.
// Raising a cap needs a reason in the commit message.
const CAP_READ_ONLY = 560;
const CAP_WITH_WRITES = 740;
const CAP_PER_TOOL = 200;

const MODES = ['code', 'dialog'] as const;

const costOf = (cfg: Config, mode: (typeof MODES)[number] = 'code') => {
  const defs = toolsFor(cfg, mode).map((t) => t.def);
  return { defs, total: encode(JSON.stringify(defs)).length + encode(INSTRUCTIONS).length };
};
const cost = (writeOps: string[], mode: (typeof MODES)[number] = 'code') => costOf(testConfig({ writeOps }), mode);

describe('token budget', () => {
  it(`read-only tools/list stays under ${CAP_READ_ONLY} tokens`, () => {
    expect(cost([]).total).toBeLessThanOrEqual(CAP_READ_ONLY);
  });

  it(`the default config (all writes on) stays under ${CAP_WITH_WRITES} tokens in both confirm modes`, () => {
    const defaults = loadConfig({ AROFLO_V2_API_KEY: 'x' }, () => {});
    expect(defaults.writeOps).toEqual(['*']);
    for (const mode of MODES) expect(costOf(defaults, mode).total, mode).toBeLessThanOrEqual(CAP_WITH_WRITES);
  });

  it(`tools/list with a list of writes stays under ${CAP_WITH_WRITES} tokens in both confirm modes`, () => {
    for (const mode of MODES) expect(cost(['Notes', 'Clients'], mode).total, mode).toBeLessThanOrEqual(CAP_WITH_WRITES);
  });

  it(`no single tool costs more than ${CAP_PER_TOOL} tokens`, () => {
    for (const mode of MODES)
      for (const def of cost(['*'], mode).defs) expect(encode(JSON.stringify(def)).length, `${mode} ${def.name}`).toBeLessThanOrEqual(CAP_PER_TOOL);
  });
});
