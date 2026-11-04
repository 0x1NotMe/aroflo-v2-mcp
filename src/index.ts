#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeDeps } from './deps.js';
import { createServer, errorText } from './server.js';
import { VERSION } from './version.js';

const deps = makeDeps();
const arg = process.argv[2];

if (arg === '--version') {
  process.stdout.write(`aroflo-v2-mcp ${VERSION} (AroFlo API ${deps.catalog.version}, spec ${deps.catalog.specSha})\n`);
} else if (arg === '--check') {
  // Setup and rotation check: one read-only call, never prints the token.
  const writes = deps.cfg.writeOps.length ? `on for ${deps.cfg.writeOps.join(', ')}` : 'off (read-only)';
  try {
    // Always a real authenticated read, even when a business unit id is configured.
    await deps.http.request('GET', '/businessunits', { query: { _fields: 'id', limit: '1' }, collection: true, template: 'GET /businessunits' });
    const left = deps.http.rate.dailyRemaining;
    process.stdout.write(`token: OK${left !== undefined ? `, AroFlo calls left today: ${left}` : ''}\nwrites: ${writes}\n`);
  } catch (err) {
    process.stdout.write(`token: FAILED: ${errorText(err, deps.cfg)}\nwrites: ${writes}\n`);
    process.exitCode = 1;
  }
} else if (arg === undefined) {
  await createServer(deps).connect(new StdioServerTransport());
} else {
  process.stderr.write('usage: aroflo-v2-mcp [--check | --version]\n');
  process.exitCode = 2;
}
