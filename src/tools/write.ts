import { createHash, randomBytes } from 'node:crypto';
import _Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { audit, idsIn } from '../audit.js';
import type { Method, Op } from '../catalog.js';
import type { Config } from '../config.js';
import { isObj, render } from '../format.js';
import { ApiError } from '../http.js';
import { buildQuery, resolveTarget, UsageError } from '../request.js';
import { writeAllowed } from '../writes.js';
import { type DialogAnswer, type Deps, str, type Tool, type ToolDef } from './types.js';

// ajv is CommonJS: under NodeNext the default import is module.exports, whose `.default` is the class.
const Ajv2020 = _Ajv2020.default;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validators = new Map<string, ValidateFunction>();

const WRITE_METHODS = new Set<Method>(['POST', 'PATCH', 'PUT', 'DELETE']);
const TTL_MS = 10 * 60_000;
/**
 * How long a confirm dialog waits for the user. The MCP SDK gives up after 60 seconds by default, too
 * short to read a long request. Codex pauses its own tool timeout while a dialog is open, so this is
 * the limit the user sees.
 */
export const DIALOG_TIMEOUT_MS = 10 * 60_000;
const CANCELLED = 'Cancelled: nothing was sent.';
/** What the model hears when a dialog ends without "send". Each says what happened, so it never blames the user for a dialog they didn't see. */
const NOT_SENT: Record<Exclude<DialogAnswer, 'send'>, string> = {
  decline:
    "Not sent: the confirm dialog came back declined. If the user saw no dialog, the client declined it by itself (Codex can do this when set to never ask for approval, as in Full Access), so they need a setting that asks. Don't retry without asking the user.",
  'kept-false': 'Not sent: the dialog was accepted with "Send to AroFlo" left on False. If the user meant to send it, call again and they choose True.',
  'no-choice': 'Not sent: the dialog was accepted without a "Send to AroFlo" choice. If the user meant to send it, call again and they choose True.',
  cancel: 'Not sent: the confirm dialog was closed without an answer.',
  timeout: `Not sent: the confirm dialog got no answer within ${DIALOG_TIMEOUT_MS / 60_000} minutes.`
};
/** Opaque AroFlo ids only in write paths, so a path (and the audit log) never carries free text. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Confirm codes: random per preview, bound to the request digest, single use. */
const issued = new Map<string, { digest: string; at: number }>();
const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');

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
      const p = e.params as { unevaluatedProperty?: string; additionalProperty?: string };
      return `${where} has an undocumented field "${p.unevaluatedProperty ?? p.additionalProperty}" (AroFlo ignores those; check aroflo_api)`;
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

interface Prepared {
  method: Method;
  op: Op;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/** Everything that can be checked without AroFlo: method, path, allowlist, query, body schema. */
async function prepare(args: Record<string, unknown>, d: Deps): Promise<Prepared> {
  const method = str(args, 'method').toUpperCase() as Method;
  if (!WRITE_METHODS.has(method)) throw new UsageError('method must be POST, PATCH, PUT or DELETE. Use aroflo_get to read.');
  const target = await resolveTarget(d.catalog, method, str(args, 'path'), d.ctx);
  const { op } = target;
  if (!writeAllowed(d.cfg, op)) throw new UsageError(`${op.k} is not enabled on this server. Enabled: ${d.cfg.writeOps.join(', ')}.`);
  for (const [name, value] of Object.entries(target.params)) {
    if (!OPAQUE_ID.test(value)) throw new UsageError(`${name} must be an AroFlo id (letters, digits, - or _).`);
  }
  const query = await buildQuery(op, target.search, d.ctx);
  const body = parseBody(args.body);
  if (body === undefined && (op.br || (op.b && method !== 'DELETE'))) throw new UsageError(`${op.k} needs a body. aroflo_api '${op.k}' lists its fields.`);
  if (body !== undefined && !op.b && !op.bin) throw new UsageError(`${op.k} takes no body.`);
  if (body !== undefined && op.b) {
    const problems = validate(op, body);
    if (problems.length) throw new UsageError(`Body rejected before sending:\n${problems.join('\n')}`);
  }
  return { method, op, path: target.path, query, body };
}

/** The whole request, never cut: this is what the user approves. */
function describeRequest(p: Prepared, pretty: boolean): string {
  const q = Object.keys(p.query).length ? `?${new URLSearchParams(p.query).toString()}` : '';
  const body = p.body === undefined ? 'body: none' : `body: ${pretty ? JSON.stringify(p.body, null, 2) : JSON.stringify(p.body)}`;
  return `${p.method} ${p.path}${q}\n${body}\n${p.method === 'DELETE' ? 'This deletes the record.' : 'AroFlo has no undo for this.'}`;
}

async function send(p: Prepared, d: Deps): Promise<string> {
  const bodySha256 = p.body === undefined ? undefined : createHash('sha256').update(canonical(p.body)).digest('hex');
  try {
    if (d.signal?.aborted) return CANCELLED;
    const res = await d.http.request(p.method, p.path, { query: p.query, body: p.body, confirmedWrite: true, template: p.op.k, signal: d.signal });
    const warn = audit(d.cfg.auditLog, { ts: new Date().toISOString(), op: p.op.k, path: p.path, status: res.status, outcome: 'ok', bodySha256, ids: idsIn(res.data) });
    const tail = warn ? `\n(${warn})` : '';
    if (res.status === 207) return `sent: ${p.op.k} -> 207\n${multiStatus(res.data)}${tail}`;
    const detail = res.data === undefined ? '' : `\n${render(res.data, { maxText: 300, maxCell: 50 })}`;
    return `sent: ${p.op.k} -> ${res.status}${detail}${tail}`;
  } catch (err) {
    const outcome = err instanceof ApiError && err.outcome === 'unknown' ? 'unknown' : 'failed';
    audit(d.cfg.auditLog, { ts: new Date().toISOString(), op: p.op.k, path: p.path, status: err instanceof ApiError ? err.status : 0, outcome, bodySha256 });
    throw err;
  }
}

/**
 * A 207 names every failed item and counts the successes, so nothing is resent or lost. AroFlo's
 * documented shape is {items: [created], errors: [{itemIndex (1-based), error: {statusCode, message}}]};
 * a per-item status list is handled too. originalData is left out: it only echoes what was sent.
 */
export function multiStatus(data: unknown): string {
  const ok = isObj(data) && Array.isArray(data.items) ? data.items.length : undefined;
  if (isObj(data) && Array.isArray(data.errors)) {
    const errs = data.errors.filter(isObj);
    const lines = errs.map((e) => {
      const err = isObj(e.error) ? e.error : {};
      const status = typeof err.statusCode === 'number' ? `${err.statusCode} ` : '';
      const msg = typeof err.message === 'string' ? err.message : typeof e.error === 'string' ? e.error : JSON.stringify(e.error ?? e);
      return `item ${String(e.itemIndex ?? '?')}: ${status}${msg}`;
    });
    const head = `207: ${errs.length} item${errs.length === 1 ? '' : 's'} failed${ok !== undefined ? `, ${ok} succeeded` : ''}. Do not resend the ones that succeeded.`;
    return lines.length ? `${head}\n${lines.join('\n')}` : head;
  }
  const rows = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.items) ? data.items : [];
  const failed = rows.filter((r) => isObj(r) && ((typeof r.status === 'number' && r.status >= 400) || r.error !== undefined || r.success === false));
  if (!rows.length) return `207: partial success, but AroFlo returned no item list:\n${render(data, { maxText: 300, maxCell: 80 })}`;
  const head = `207: ${failed.length} of ${rows.length} items failed; the other ${rows.length - failed.length} succeeded. Do not resend the ones that succeeded.`;
  return failed.length ? `${head}\n${failed.map((f) => `item ${JSON.stringify(f)}`).join('\n')}` : head;
}

const baseSchema = {
  method: { type: 'string', enum: ['POST', 'PATCH', 'PUT', 'DELETE'] },
  path: { type: 'string' },
  body: { type: 'object' }
};

/**
 * Two ways to get the user's OK, chosen per client at connect time:
 * - dialog: the client supports MCP elicitation (Codex does). One call; the server asks the user
 *   directly in a confirm dialog showing the exact request. The model cannot answer it. Only a
 *   "send" answer sends; every other ending says what happened (see NOT_SENT).
 * - code: no elicitation. The first call returns the full request and a single-use code; the model
 *   must show it and pass the code back. The client's own tool-approval prompt is the human gate
 *   here, so it must stay on for aroflo_write.
 */
export function makeWriteTool(cfg: Config, mode: 'dialog' | 'code'): Tool {
  const enabled = cfg.writeOps.includes('*') ? 'all write endpoints' : cfg.writeOps.join(', ');
  const def: ToolDef =
    mode === 'dialog'
      ? {
          name: 'aroflo_write',
          description: `Create or change AroFlo records (enabled: ${enabled}). Each call opens a confirm dialog showing the exact request; nothing is sent unless the user accepts. Writes are permanent. aroflo_api 'POST /path' shows the body fields.`,
          inputSchema: { type: 'object', properties: baseSchema, required: ['method', 'path'], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        }
      : {
          name: 'aroflo_write',
          description: `Create or change AroFlo records (enabled: ${enabled}). First call returns a preview and a code: show the preview to the user, and only after they agree call again with identical arguments plus confirm=<code>. Writes are permanent. aroflo_api 'POST /path' shows the body fields.`,
          inputSchema: { type: 'object', properties: { ...baseSchema, confirm: { type: 'string' } }, required: ['method', 'path'], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        };

  return {
    def,
    async run(args, d) {
      const p = await prepare(args, d);

      if (mode === 'dialog') {
        if (!d.askUser) throw new UsageError('This client cannot show a confirm dialog; reconnect the MCP server.');
        let answer: DialogAnswer;
        try {
          answer = await d.askUser(`Send this to AroFlo?\n\n${describeRequest(p, true)}`);
        } catch (err) {
          if (d.signal?.aborted) return CANCELLED;
          return `Not sent: the confirm dialog failed (${err instanceof Error ? err.message : String(err)}).`;
        }
        if (answer === 'send') return send(p, d);
        return d.signal?.aborted ? CANCELLED : NOT_SENT[answer];
      }

      const digest = digestOf(`${p.method} ${p.path}?${canonical(p.query)}\n${canonical(p.body)}`);
      const now = Date.now();
      for (const [c, e] of issued) if (now - e.at > TTL_MS) issued.delete(c);
      const confirm = typeof args.confirm === 'string' ? args.confirm.trim() : '';
      if (!confirm) {
        const code = randomBytes(6).toString('hex');
        issued.set(code, { digest, at: now });
        return `PREVIEW, nothing sent:\n${describeRequest(p, false)}\nShow this to the user. To send it, call aroflo_write again with identical method, path and body plus confirm="${code}". The code works once, for 10 minutes.`;
      }
      const entry = issued.get(confirm);
      if (!entry) throw new UsageError('That confirm code has expired or was already used. Preview again.');
      if (entry.digest !== digest) throw new UsageError('That confirm code is for a different request: method, path and body must be identical to the preview. Preview again.');
      issued.delete(confirm); // single use, before sending: a retried call can never send twice
      return send(p, d);
    }
  };
}
