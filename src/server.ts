import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import { ApiError } from './http.js';
import { UsageError } from './request.js';
import { apiTool } from './tools/api.js';
import { getTool } from './tools/get.js';
import { jobTool } from './tools/job.js';
import { quoteTool } from './tools/quote.js';
import type { Deps, Tool } from './tools/types.js';
import { makeWriteTool } from './tools/write.js';
import { VERSION } from './version.js';

export const INSTRUCTIONS =
  'AroFlo field-service data for one business. aroflo_job and aroflo_quote answer most questions about a single job or quote in one call; aroflo_get reads any list or record; aroflo_api finds paths and filters. Ask for few rows and columns.';

/** Low daily budget: tell the model, so it stops spending calls. */
const BUDGET_WARN = 250;
/** Hard ceiling on one tool result (~15k tokens), whatever the arguments: full=true included. */
export const MAX_OUTPUT_CHARS = 60_000;

/** The write tool's confirm mode depends on the client, so the tool list is built after initialize. */
export function toolsFor(cfg: Config, writeMode: 'dialog' | 'code' = 'code'): Tool[] {
  const tools = [jobTool, quoteTool, getTool, apiTool];
  if (cfg.writeOps.length) tools.push(makeWriteTool(cfg, writeMode));
  return tools;
}

export function errorText(err: unknown, cfg: Config): string {
  const msg = err instanceof UsageError || err instanceof ApiError ? err.message : `Internal error: ${err instanceof Error ? err.message : String(err)}`;
  return cfg.token ? msg.split(cfg.token).join('[token]') : msg;
}

export async function callTool(tools: Tool[], name: string, args: Record<string, unknown>, deps: Deps): Promise<{ text: string; isError: boolean }> {
  const tool = tools.find((t) => t.def.name === name);
  if (!tool) return { text: `Unknown tool ${name}. Tools: ${tools.map((t) => t.def.name).join(', ')}.`, isError: true };
  try {
    let text = await tool.run(args, deps);
    if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [output cut at ${MAX_OUTPUT_CHARS} chars of ${text.length}; narrow it with _fields, limit or a filter]`;
    const left = deps.http.rate.dailyRemaining;
    if (left !== undefined && left < BUDGET_WARN) text += `\n[AroFlo calls left today: ${left}]`;
    return { text, isError: false };
  } catch (err) {
    return { text: errorText(err, deps.cfg), isError: true };
  }
}

export function createServer(deps: Deps): Server {
  const server = new Server({ name: 'aroflo-v2', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  // AROFLO_V2_DEBUG_FILE: record which client connected and what it supports (no AroFlo data).
  const debugFile = process.env.AROFLO_V2_DEBUG_FILE;
  if (debugFile) server.oninitialized = () => writeFileSync(debugFile, `${JSON.stringify({ client: server.getClientVersion(), capabilities: server.getClientCapabilities() })}\n`);
  const canAsk = () => server.getClientCapabilities()?.elicitation !== undefined;
  const askUser = (signal?: AbortSignal) => async (message: string) => {
    const r = await server.elicitInput(
      {
        mode: 'form',
        message,
        requestedSchema: { type: 'object', properties: { send: { type: 'boolean', title: 'Send to AroFlo', default: false } }, required: ['send'] }
      },
      { signal }
    );
    return r.action === 'accept' && r.content?.send === true;
  };
  const current = () => toolsFor(deps.cfg, canAsk() ? 'dialog' : 'code');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: current().map((t) => t.def) }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tools = current();
    if (!tools.some((t) => t.def.name === req.params.name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${req.params.name}. Tools: ${tools.map((t) => t.def.name).join(', ')}.`);
    const callDeps: Deps = { ...deps, signal: extra.signal, ...(canAsk() ? { askUser: askUser(extra.signal) } : {}) };
    const { text, isError } = await callTool(tools, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, callDeps);
    return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
  });
  return server;
}
