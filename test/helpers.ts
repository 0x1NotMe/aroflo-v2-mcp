import type { Config } from '../src/config.js';

export const TOKEN = 'AF.test-token-1234567890';

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    token: TOKEN,
    baseUrl: 'https://api.test/v2',
    writeOps: [],
    maxRpm: 120,
    timeoutMs: 5_000,
    auditLog: '/dev/null',
    defaultLimit: 25,
    debug: false,
    ...over
  };
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  error?: Error;
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

type Handler = (call: Call) => Reply;

/** A fetch stand-in routed by "METHOD /path" with `*` matching one path segment. Records every call. */
export function fakeFetch(routes: Record<string, Handler | Reply | Reply[]>) {
  const calls: Call[] = [];
  const counters = new Map<string, number>();
  const fn = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/v2/, '');
    const call: Call = {
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    for (const [key, handler] of Object.entries(routes)) {
      const [m, p] = key.split(' ');
      const re = new RegExp(`^${p!.replace(/\*/g, '[^/]+')}$`);
      if (m !== method || !re.test(path)) continue;
      let reply: Reply;
      if (typeof handler === 'function') reply = handler(call);
      else if (Array.isArray(handler)) {
        const n = counters.get(key) ?? 0;
        counters.set(key, n + 1);
        reply = handler[Math.min(n, handler.length - 1)]!;
      } else reply = handler;
      if (reply.error) throw reply.error;
      return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...reply.headers }
      });
    }
    return new Response(JSON.stringify({ error: `no fake route for ${method} ${path}` }), { status: 404 });
  };
  return { fn, calls };
}

export const noSleep = async () => {};

/** A paged list endpoint over `rows`, honouring page/limit like AroFlo. */
export function pagedList(rows: unknown[]): Handler {
  return (call) => {
    const limit = Number(call.query.limit ?? 30);
    const page = Number(call.query.page ?? 1);
    const items = rows.slice((page - 1) * limit, page * limit);
    return { body: { count: rows.length, page: { number: page, size: limit, count: Math.max(1, Math.ceil(rows.length / limit)) }, items } };
  };
}
