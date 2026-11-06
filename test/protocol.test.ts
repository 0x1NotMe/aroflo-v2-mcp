import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type ElicitRequest, ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { makeDeps } from '../src/deps.js';
import { AroFloHttp } from '../src/http.js';
import { createServer } from '../src/server.js';
import { fakeFetch, noSleep, testConfig } from './helpers.js';

/** How the test client answers a confirm dialog. Without one, the client has no dialogs (no elicitation). */
type Answer = (params: ElicitRequest['params']) => ElicitResult | Promise<ElicitResult>;

async function connect(cfg: Config, answer?: Answer) {
  const f = fakeFetch({ 'PATCH /clients/C1': { body: { id: 'C1' } }, 'GET /businessunits': { body: { items: [{ id: 'BU1' }] } } });
  const server = createServer(makeDeps(cfg, new AroFloHttp(cfg, f.fn, noSleep)));
  const client = new Client({ name: 'test', version: '0' }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const asked: ElicitRequest['params'][] = [];
  if (answer) client.setRequestHandler(ElicitRequestSchema, async (req) => (asked.push(req.params), answer(req.params)));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  // The client's own request timeout is long here, so only the server's dialog timeout can end a call.
  const write = async () => {
    const r = await client.callTool({ name: 'aroflo_write', arguments: { method: 'PATCH', path: '/clients/C1', body: { individual: true } } }, undefined, { timeout: 60 * 60_000 });
    return (r.content as { text: string }[])[0]!.text;
  };
  return { client, asked, write, patches: () => f.calls.filter((c) => c.method === 'PATCH').length };
}

const writes = testConfig({ writeOps: ['Clients'] });

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP protocol', () => {
  it('answers an unknown tool with a protocol error', async () => {
    const { client } = await connect(testConfig());
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool nope/);
  });

  it('offers the dialog form of aroflo_write to clients with elicitation, and sends after the user chooses True', async () => {
    const c = await connect(writes, () => ({ action: 'accept', content: { send: true } }));
    const { tools } = await c.client.listTools();
    const write = tools.find((t) => t.name === 'aroflo_write')!;
    expect(Object.keys(write.inputSchema.properties ?? {})).toEqual(['method', 'path', 'body']);
    expect(await c.write()).toMatch(/^sent: PATCH/);
    expect(c.patches()).toBe(1);
  });

  it('asks with a required Send field that starts on false, showing the exact request', async () => {
    const c = await connect(writes, () => ({ action: 'decline' }));
    await c.write();
    expect(c.asked).toHaveLength(1);
    expect(c.asked[0]).toMatchObject({ mode: 'form', requestedSchema: { properties: { send: { type: 'boolean', default: false } }, required: ['send'] } });
    expect(c.asked[0]!.message).toContain('PATCH /clients/C1');
    expect(c.asked[0]!.message).toContain('"individual": true');
  });

  it.each<[string, ElicitResult, RegExp]>([
    ['declined, which may mean the client declined it by itself', { action: 'decline' }, /^Not sent: the confirm dialog came back declined\. If the user saw no dialog, the client declined it by itself/],
    ['accepted with Send left on false', { action: 'accept', content: { send: false } }, /^Not sent: the dialog was accepted with "Send to AroFlo" left on False\./],
    ['accepted with no answer at all', { action: 'accept' }, /^Not sent: the dialog was accepted with "Send to AroFlo" left on False\./],
    ['closed', { action: 'cancel' }, /^Not sent: the confirm dialog was closed without an answer\.$/]
  ])('sends nothing when the dialog is %s, and says so', async (_, result, text) => {
    const c = await connect(writes, () => result);
    expect(await c.write()).toMatch(text);
    expect(c.patches()).toBe(0);
  });

  it('sends nothing when a client accepts the dialog by itself, with empty content', async () => {
    // Codex auto-accepts a dialog without fields as {action: accept, content: {}}. Ours has a required field.
    const c = await connect(writes, () => ({ action: 'accept', content: {} }));
    expect(await c.write()).toMatch(/^Not sent: /);
    expect(c.patches()).toBe(0);
  });

  it('keeps the dialog open for 10 minutes, not the SDK default of 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = await connect(writes, () => new Promise<ElicitResult>(() => {}));
    let text: string | undefined;
    const pending = c.write().then((t) => (text = t));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(text).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(text).toBe('Not sent: the confirm dialog got no answer within 10 minutes.');
    expect(c.patches()).toBe(0);
  });

  it('offers the code form to clients without elicitation', async () => {
    const { client } = await connect(writes);
    const { tools } = await client.listTools();
    expect(Object.keys(tools.find((t) => t.name === 'aroflo_write')!.inputSchema.properties ?? {})).toContain('confirm');
  });
});
