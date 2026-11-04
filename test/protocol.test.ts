import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { makeDeps } from '../src/deps.js';
import { AroFloHttp } from '../src/http.js';
import { createServer } from '../src/server.js';
import { fakeFetch, noSleep, testConfig } from './helpers.js';

async function connect(cfg: Config, elicitation: boolean, answer = true) {
  const f = fakeFetch({ 'PATCH /clients/C1': { body: { id: 'C1' } }, 'GET /businessunits': { body: { items: [{ id: 'BU1' }] } } });
  const server = createServer(makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)));
  const client = new Client({ name: 'test', version: '0' }, { capabilities: elicitation ? { elicitation: { form: {} } } : {} });
  if (elicitation) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: answer ? 'accept' : 'decline', content: answer ? { send: true } : undefined }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, f };
}

describe('MCP protocol', () => {
  it('answers an unknown tool with a protocol error', async () => {
    const { client } = await connect(testConfig(), false);
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool nope/);
  });

  it('offers the dialog form of aroflo_write to clients with elicitation, and sends after the user accepts', async () => {
    const { client, f } = await connect(testConfig({ writeOps: ['Clients'] }), true);
    const { tools } = await client.listTools();
    const write = tools.find((t) => t.name === 'aroflo_write')!;
    expect(Object.keys(write.inputSchema.properties ?? {})).toEqual(['method', 'path', 'body']);
    const r = await client.callTool({ name: 'aroflo_write', arguments: { method: 'PATCH', path: '/clients/C1', body: { individual: true } } });
    expect((r.content as { text: string }[])[0]!.text).toMatch(/^sent: PATCH/);
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('sends nothing when the user declines the dialog', async () => {
    const { client, f } = await connect(testConfig({ writeOps: ['Clients'] }), true, false);
    const r = await client.callTool({ name: 'aroflo_write', arguments: { method: 'PATCH', path: '/clients/C1', body: { individual: true } } });
    expect((r.content as { text: string }[])[0]!.text).toBe('Not sent: the user declined.');
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('offers the code form to clients without elicitation', async () => {
    const { client } = await connect(testConfig({ writeOps: ['Clients'] }), false);
    const { tools } = await client.listTools();
    expect(Object.keys(tools.find((t) => t.name === 'aroflo_write')!.inputSchema.properties ?? {})).toContain('confirm');
  });
});
