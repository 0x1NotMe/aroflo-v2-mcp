#!/usr/bin/env node
// Token cost of what an MCP client loads every turn: tools/list (+ server instructions).
// Counts with the o200k tokenizer (OpenAI GPT-4o/GPT-5 family, what Codex uses).
// usage: node scripts/measure-tokens.mjs [--v1 <path to v1 server.js>]
import { spawn } from 'node:child_process';
import { encode } from 'gpt-tokenizer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function measure(label, command, args, env) {
  const client = new Client({ name: 'measure', version: '0' });
  const transport = new StdioClientTransport({ command, args, env: { PATH: process.env.PATH, ...env }, stderr: 'ignore' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? '';
  await client.close();
  const json = JSON.stringify(tools);
  const t = encode(json).length + encode(instructions).length;
  console.log(`${label}: ${tools.length} tools, ${json.length} chars, ~${t} tokens per turn`);
  return t;
}

const v2 = new URL('../dist/index.js', import.meta.url).pathname;
const read = await measure('v2 read-only', process.execPath, [v2], { AROFLO_V2_API_KEY: 'x' });
await measure('v2 with writes', process.execPath, [v2], { AROFLO_V2_API_KEY: 'x', AROFLO_V2_WRITE_OPS: 'Notes,Clients' });
const i = process.argv.indexOf('--v1');
if (i > 0) {
  const dummy = { AROFLO_SECRET_KEY: 'x', AROFLO_UENCODED: 'x', AROFLO_PENCODED: 'x', AROFLO_ORG_ENCODED: 'x' };
  const v1 = await measure('v1 aroflo-mcp', process.execPath, [process.argv[i + 1]], dummy);
  console.log(`v2 read-only is ${Math.round((1 - read / v1) * 100)}% smaller than v1`);
}
