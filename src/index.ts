#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeDeps } from './deps.js';
import { createServer, errorText } from './server.js';
import { VERSION } from './version.js';

let deps: ReturnType<typeof makeDeps>;
try {
  deps = makeDeps();
} catch (err) {
  // Usually spec/catalog.json missing next to dist/ (a copy of dist/ alone): one line, not a stack trace.
  process.stderr.write(`aroflo-v2-mcp: cannot start: ${(err as Error).message.split('\n')[0]}. Reinstall from the repo: npm ci && npm run build.\n`);
  process.exit(1);
}
const arg = process.argv[2];

if (arg === '--version') {
  process.stdout.write(`aroflo-v2-mcp ${VERSION} (AroFlo API ${deps.catalog.version}, spec ${deps.catalog.specSha})\n`);
} else if (arg === '--check') {
  // Setup and rotation check: one read-only call, never prints the token.
  const ops = deps.cfg.writeOps;
  const writes = !ops.length ? 'off (read-only)' : `on for ${ops.includes('*') ? 'all write endpoints' : ops.join(', ')}, each one confirmed`;
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
