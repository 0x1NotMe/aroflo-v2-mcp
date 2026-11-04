import { createHash, createHmac, randomBytes } from 'node:crypto';
import _Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { audit, idsIn } from '../audit.js';
import type { Method, Op } from '../catalog.js';
import type { Config } from '../config.js';
import { cut, isObj, render } from '../format.js';
import { ApiError } from '../http.js';
import { buildQuery, resolveTarget, UsageError } from '../request.js';
import { writeAllowed } from '../writes.js';
import { str, type Tool } from './types.js';

// ajv is CommonJS: under NodeNext the default import is module.exports, whose `.default` is the class.
const Ajv2020 = _Ajv2020.default;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validators = new Map<string, ValidateFunction>();

const WRITE_METHODS = new Set<Method>(['POST', 'PATCH', 'PUT', 'DELETE']);
const TTL_MS = 10 * 60_000;
/** Per-process secret: the model cannot mint a confirm code without asking for a preview. */
const SALT = randomBytes(32);
const issued = new Map<string, number>();

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

function validate(op: Op, body: unknown): string[] {
  if (!op.b) return [];
  const fn = validators.get(op.k) ?? ajv.compile(op.b);
  validators.set(op.k, fn);
  if (fn(body)) return [];
  return (fn.errors ?? []).slice(0, 8).map((e: ErrorObject) => {
    const where = e.instancePath ? `body${e.instancePath.replace(/\//g, '.')}` : 'body';
    if (e.keyword === 'unevaluatedProperties' || e.keyword === 'additionalProperties') {
      const extra = (e.params as { unevaluatedProperty?: string; additionalProperty?: string }).unevaluatedProperty ?? (e.params as { additionalProperty?: string }).additionalProperty;
      return `${where} has an undocumented field "${extra}" (AroFlo ignores those; check aroflo_api)`;
    }
    if (e.keyword === 'enum') return `${where} must be one of ${((e.params as { allowedValues?: unknown[] }).allowedValues ?? []).join(', ')}`;
    return `${where} ${e.message ?? 'is invalid'}`;
  });
}

function parseBody(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError('body must be a JSON object.');
    }
  }
  return raw;
}

export function makeWriteTool(cfg: Config): Tool {
  return {
    def: {
      name: 'aroflo_write',
      description: `Create or change AroFlo records (enabled: ${cfg.writeOps.join(', ')}). First call without confirm returns a preview and a code: show the preview to the user. Only after they agree, call again with identical arguments plus confirm=<code>. Writes are permanent; aroflo_api 'POST /path' shows the body fields.`,
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['POST', 'PATCH', 'PUT', 'DELETE'] },
          path: { type: 'string' },
          body: { type: 'object' },
          confirm: { type: 'string' }
        },
        required: ['method', 'path'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },

    async run(args, d) {
      const method = str(args, 'method').toUpperCase() as Method;
      if (!WRITE_METHODS.has(method)) throw new UsageError('method must be POST, PATCH, PUT or DELETE. Use aroflo_get to read.');
      const target = await resolveTarget(d.catalog, method, str(args, 'path'), d.ctx);
      const { op } = target;
      if (!writeAllowed(d.cfg, op)) throw new UsageError(`${op.k} is not enabled on this server. Enabled: ${d.cfg.writeOps.join(', ')}.`);
      const query = await buildQuery(op, target.search, d.ctx);
      const body = parseBody(args.body);
      if (body === undefined && (op.br || (op.b && method !== 'DELETE'))) throw new UsageError(`${op.k} needs a body. aroflo_api '${op.k}' lists its fields.`);
      if (body !== undefined && !op.b && !op.bin) throw new UsageError(`${op.k} takes no body.`);
      if (body !== undefined && op.b) {
        const problems = validate(op, body);
        if (problems.length) throw new UsageError(`Body rejected before sending:\n${problems.join('\n')}`);
      }

      const request = `${method} ${target.path}?${canonical(query)}\n${canonical(body)}`;
      const code = createHmac('sha256', SALT).update(request).digest('hex').slice(0, 10);
      const now = Date.now();
      for (const [c, at] of issued) if (now - at > TTL_MS) issued.delete(c);

      const confirm = typeof args.confirm === 'string' ? args.confirm.trim() : '';
      if (!confirm) {
        issued.set(code, now);
        const shownQuery = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
        return [
          `PREVIEW, nothing sent: ${method} ${target.path}${shownQuery}`,
          body !== undefined ? `body: ${cut(JSON.stringify(body), 1500, true)}` : 'body: none',
          method === 'DELETE' ? 'This deletes the record.' : 'AroFlo has no undo for this.',
          `Show this to the user. To send it, call aroflo_write again with identical method, path and body plus confirm="${code}". The code works once, for 10 minutes.`
        ].join('\n');
      }
      if (confirm !== code) throw new UsageError('That confirm code is for a different request: method, path and body must be identical to the preview. Preview again.');
      if (!issued.has(code)) throw new UsageError('That confirm code has expired or was already used. Preview again.');
      issued.delete(code); // single use, before sending: a retried call can never send twice

      const bodySha256 = body === undefined ? undefined : createHash('sha256').update(canonical(body)).digest('hex');
      try {
        const res = await d.http.request(method, target.path, { query, body, confirmedWrite: true, template: op.k });
        const warn = audit(d.cfg.auditLog, { ts: new Date().toISOString(), op: op.k, path: target.path, status: res.status, outcome: 'ok', bodySha256, ids: idsIn(res.data) });
        const detail = res.data === undefined ? '' : `\n${render(res.data, { maxText: 300, maxCell: 50 })}`;
        const partial = res.status === 207 ? '\n207: some items failed; the rows above say which. Do not resend the ones that succeeded.' : '';
        return `sent: ${op.k} -> ${res.status}${detail}${partial}${warn ? `\n(${warn})` : ''}`;
      } catch (err) {
        const outcome = err instanceof ApiError && err.outcome === 'unknown' ? 'unknown' : 'failed';
        audit(d.cfg.auditLog, { ts: new Date().toISOString(), op: op.k, path: target.path, status: err instanceof ApiError ? err.status : 0, outcome, bodySha256 });
        throw err;
      }
    }
  };
}
