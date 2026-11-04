import { encode } from 'gpt-tokenizer';
import { describe, expect, it } from 'vitest';
import { INSTRUCTIONS, toolsFor } from '../src/server.js';
import { testConfig } from './helpers.js';

// Every MCP client sends the tool list to the model on every turn. v1 (aroflo-mcp) cost ~26,000 tokens
// per turn for 51 tools; these caps keep v2 near 500. Raising a cap needs a reason in the commit message.
const CAP_READ_ONLY = 560;
const CAP_WITH_WRITES = 740;
const CAP_PER_TOOL = 200;

const cost = (writeOps: string[]) => {
  const defs = toolsFor(testConfig({ writeOps })).map((t) => t.def);
  return { defs, total: encode(JSON.stringify(defs)).length + encode(INSTRUCTIONS).length };
};

describe('token budget', () => {
  it(`read-only tools/list stays under ${CAP_READ_ONLY} tokens`, () => {
    expect(cost([]).total).toBeLessThanOrEqual(CAP_READ_ONLY);
  });

  it(`tools/list with writes enabled stays under ${CAP_WITH_WRITES} tokens`, () => {
    expect(cost(['Notes', 'Clients']).total).toBeLessThanOrEqual(CAP_WITH_WRITES);
  });

  it(`no single tool costs more than ${CAP_PER_TOOL} tokens`, () => {
    for (const def of cost(['Notes', 'Clients']).defs) expect(encode(JSON.stringify(def)).length, def.name).toBeLessThanOrEqual(CAP_PER_TOOL);
  });
});
