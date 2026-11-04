import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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

export function toolsFor(cfg: Config): Tool[] {
  const tools = [jobTool, quoteTool, getTool, apiTool];
  if (cfg.writeOps.length) tools.push(makeWriteTool(cfg));
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
    const left = deps.http.rate.dailyRemaining;
    if (left !== undefined && left < BUDGET_WARN) text += `\n[AroFlo calls left today: ${left}]`;
    return { text, isError: false };
  } catch (err) {
    return { text: errorText(err, deps.cfg), isError: true };
  }
}

export function createServer(deps: Deps): Server {
  const tools = toolsFor(deps.cfg);
  const server = new Server({ name: 'aroflo-v2', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => t.def) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { text, isError } = await callTool(tools, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, deps);
    return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
  });
  return server;
}
