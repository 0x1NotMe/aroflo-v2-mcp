import { readFileSync } from 'node:fs';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export const METHODS: readonly Method[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

/** Query parameter as stored in spec/catalog.json (short keys keep the file small). */
export interface Param {
  n: string;
  t?: string;
  r?: 1;
  e?: Array<string | number | boolean>;
  def?: unknown;
  min?: number;
  max?: number;
  fmt?: string;
  d?: string;
}

/** One API operation from spec/catalog.json. */
export interface Op {
  k: string;
  m: Method;
  p: string;
  tags: string[];
  s: string;
  d: string;
  q: Param[];
  pp: string[];
  codes: number[];
  b?: Record<string, unknown>;
  br?: 1;
  bin?: 1;
  f?: string[];
  list?: 1;
  paged?: 1;
  ex?: unknown;
}

export interface CatalogFile {
  version: string;
  specSha: string;
  ops: Op[];
}

export interface Match {
  op: Op;
  params: Record<string, string>;
}

interface Compiled {
  op: Op;
  re: RegExp;
  literals: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const METHOD_WORDS: Record<string, Method> = {
  list: 'GET', get: 'GET', read: 'GET', show: 'GET', find: 'GET', view: 'GET', search: 'GET',
  create: 'POST', add: 'POST', new: 'POST', insert: 'POST', post: 'POST', upload: 'POST', record: 'POST',
  update: 'PATCH', edit: 'PATCH', change: 'PATCH', patch: 'PATCH', set: 'PATCH', archive: 'PATCH', assign: 'PUT',
  delete: 'DELETE', remove: 'DELETE'
};
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'on', 'in', 'by', 'and', 'or', 'with', 'all', 'my', 'me', 'api']);

const singular = (w: string) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);

export class ApiCatalog {
  readonly ops: Op[];
  readonly version: string;
  readonly specSha: string;
  private readonly compiled: Compiled[];
  private readonly byKey: Map<string, Op>;

  constructor(file: CatalogFile) {
    this.ops = file.ops;
    this.version = file.version;
    this.specSha = file.specSha;
    this.byKey = new Map(file.ops.map((o) => [o.k, o]));
    this.compiled = file.ops
      .map((op) => {
        const segs = op.p.split('/').filter(Boolean);
        const pattern = segs.map((s) => (s.startsWith('{') ? '([^/]+)' : escapeRe(s))).join('/');
        return { op, re: new RegExp(`^/${pattern}$`, 'i'), literals: segs.filter((s) => !s.startsWith('{')).length };
      })
      .sort((a, b) => b.literals - a.literals);
  }

  static load(url: URL = new URL('../spec/catalog.json', import.meta.url)): ApiCatalog {
    return new ApiCatalog(JSON.parse(readFileSync(url, 'utf8')) as CatalogFile);
  }

  get(key: string): Op | undefined {
    return this.byKey.get(key);
  }

  /** Match a concrete path (no query string) to an operation. Templates with more literal segments win. */
  match(method: Method, path: string): Match | undefined {
    for (const c of this.compiled) {
      if (c.op.m !== method) continue;
      const m = c.re.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      c.op.pp.forEach((name, i) => {
        params[name] = safeDecode(m[i + 1] ?? '');
      });
      return { op: c.op, params };
    }
    return undefined;
  }

  /** Methods available for a concrete path, for "did you mean" hints. */
  methodsFor(path: string): Method[] {
    return METHODS.filter((m) => this.match(m, path));
  }

  /** Rank operations against free-text words. Method words (list, create, update...) favour that method. */
  search(text: string, opts: { methods?: readonly Method[]; limit?: number } = {}): Op[] {
    const raw = words(text).filter((w) => !STOP.has(w));
    const wanted = new Set(raw.map((w) => METHOD_WORDS[w]).filter((m): m is Method => Boolean(m)));
    const terms = raw.filter((w) => !METHOD_WORDS[w]);
    for (let i = 0; i + 1 < raw.length; i++) terms.push(`${raw[i]}${raw[i + 1]}`, singular(`${raw[i]}${raw[i + 1]}`));
    if (!terms.length && !wanted.size) return [];
    const scored = [];
    for (const op of this.ops) {
      if (opts.methods && !opts.methods.includes(op.m)) continue;
      const pathWords = new Set(op.p.split('/').filter((s) => s && !s.startsWith('{')).flatMap((s) => [singular(s.toLowerCase()), ...words(s)]));
      const tagWords = new Set([...op.tags.flatMap(words), ...words(op.s)]);
      const descWords = new Set(words(op.d.slice(0, 400)));
      let score = 0;
      for (const t of terms) {
        if (pathWords.has(t)) score += 3;
        else if (tagWords.has(t)) score += 2;
        else if (descWords.has(t)) score += 0.5;
      }
      if (score === 0 && terms.length) continue;
      if (wanted.has(op.m)) score += 2;
      scored.push({ op, score });
    }
    scored.sort((a, b) => b.score - a.score || a.op.p.length - b.op.p.length);
    return scored.slice(0, opts.limit ?? 12).map((s) => s.op);
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
