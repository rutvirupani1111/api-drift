import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createBaseline, learn, type Baseline } from '../src/core/baseline';
import { infer } from '../src/core/infer';
import { generateTypes, shapeToSource, typeNameForKey } from '../src/core/typegen';

const KEY = 'GET api.shop.test /api/users/:id 2xx';

function sample(i: number) {
  const user: Record<string, unknown> = {
    id: i,
    email: `user${i}@shop.test`,
    status: ['active', 'paused', 'banned'][i % 3],
    created_at: '2026-10-23T02:40:00Z',
    score: i + 0.5,
    'content-type': 'application/json',
    tags: i % 4 ? ['x', 'y'] : [],
    address: { city: 'Mumbai', zip: '400001' },
    orders: [{ id: `ord_${i}`, total: 12.5 }],
    homepage: i % 2 ? 'https://example.com' : null,
    flags: { '101': true, '202': false },
  };
  if (i % 3 === 0) user.nickname = 'nick';
  return user;
}

function baseline(n = 24): Baseline {
  let b = createBaseline();
  for (let i = 0; i < n; i++) b = learn(b, KEY, sample(i), { at: 0 });
  return b;
}

/** Type-check virtual files with the real TypeScript compiler. */
function typecheck(files: Record<string, string>): string[] {
  const root = `${process.cwd().replace(/\\/g, '/')}/__virtual__/`;
  const map = new Map(Object.entries(files).map(([k, v]) => [root + k, v]));
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2020.d.ts'],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const norm = (n: string) => n.replace(/\\/g, '/');
  host.getSourceFile = (name, lang, ...rest) =>
    map.has(norm(name)) ? ts.createSourceFile(name, map.get(norm(name))!, lang) : getSourceFile(name, lang, ...rest);
  host.fileExists = (name) => map.has(norm(name)) || fileExists(name);
  host.readFile = (name) => map.get(norm(name)) ?? readFile(name);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (dir) => root.startsWith(`${norm(dir).replace(/\/$/, '')}/`) || (directoryExists ? directoryExists(dir) : true);
  const program = ts.createProgram([...map.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

/** A ~60 line stand-in for zod: enough of the API to run generated schemas. */
function miniZod() {
  type Check = (v: unknown, path: string) => void;
  const fail = (path: string, msg: string): never => {
    throw new Error(`${path}: ${msg}`);
  };
  class S {
    constructor(
      readonly check: Check,
      readonly fields?: Record<string, S>,
    ) {}
    optional() {
      return new S((v, p) => v === undefined || this.check(v, p));
    }
    nullable() {
      return new S((v, p) => v === null || this.check(v, p));
    }
    int() {
      return new S((v, p) => (this.check(v, p), Number.isInteger(v) || fail(p, 'not an integer')));
    }
    regex(re: RegExp) {
      return new S((v, p) => (this.check(v, p), re.test(v as string) || fail(p, `does not match ${re}`)));
    }
    catchall(rest: S) {
      return new S((v, p) => {
        this.check(v, p);
        for (const [k, x] of Object.entries(v as object)) if (!(k in this.fields!)) rest.check(x, `${p}.${k}`);
      });
    }
    parse(v: unknown) {
      this.check(v, '$');
      return v;
    }
  }
  const type = (t: string) => new S((v, p) => typeof v === t || fail(p, `expected ${t}`));
  return {
    null: () => new S((v, p) => v === null || fail(p, 'expected null')),
    boolean: () => type('boolean'),
    number: () => type('number'),
    string: () => type('string'),
    unknown: () => new S(() => undefined),
    literal: (x: unknown) => new S((v, p) => v === x || fail(p, `expected ${JSON.stringify(x)}`)),
    enum: (xs: string[]) => new S((v, p) => xs.includes(v as string) || fail(p, `not one of ${xs.join(',')}`)),
    array: (s: S) => new S((v, p) => (Array.isArray(v) ? v.forEach((x, i) => s.check(x, `${p}[${i}]`)) : fail(p, 'expected array'))),
    union: (ss: S[]) =>
      new S((v, p) => {
        for (const s of ss) {
          try {
            return s.check(v, p);
          } catch {
            // try the next variant
          }
        }
        fail(p, 'no union variant matched');
      }),
    record: (_k: S, s: S) => new S((v, p) => Object.entries(v as object).forEach(([k, x]) => s.check(x, `${p}.${k}`))),
    object: (fields: Record<string, S>) =>
      new S((v, p) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) fail(p, 'expected object');
        for (const [k, s] of Object.entries(fields)) s.check((v as Record<string, unknown>)[k], `${p}.${k}`);
      }, fields),
  };
}

/** Evaluate generated Zod source against the mini zod and return its exports. */
function loadZod(source: string): Record<string, { parse(v: unknown): unknown }> {
  const names = [...source.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
  const js = source
    .replace(/^import .*$/gm, '')
    .replace(/^export type .*$/gm, '')
    .replace(/^export const /gm, 'const ');
  return new Function('z', `${js}\nreturn { ${names.join(', ')} };`)(miniZod());
}

describe('typeNameForKey', () => {
  it.each([
    ['GET api.github.com /repos/nodejs/node 2xx', 'GetReposNodejsNode'],
    ['GET api.github.com /repos/:id/pulls 2xx', 'GetReposByIdPulls'],
    ['POST api.x.test /v1/orders 2xx', 'PostV1Orders'],
    ['GET api.x.test /users/:id 4xx', 'GetUsersByIdStatus4xx'],
    ['GET api.x.test / 2xx', 'Get'],
    ['orders-queue', 'OrdersQueue'],
    ['123 events', 'T123Events'],
  ])('%s -> %s', (key, name) => {
    expect(typeNameForKey(key)).toBe(name);
  });
});

describe('generateTypes: TypeScript', () => {
  const source = generateTypes(baseline());

  it('matches the snapshot', () => {
    expect(source).toMatchSnapshot();
  });

  it('marks optional and nullable fields, enums and formats', () => {
    expect(source).toContain('nickname?: string;');
    expect(source).toContain('homepage: string | null;');
    expect(source).toContain('status: "active" | "banned" | "paused";');
    expect(source).toContain('/** Format: date-time */');
    expect(source).toContain('"content-type": "application/json";');
    expect(source).toContain('orders: GetApiUsersByIdOrdersItem[];');
    expect(source).toContain('flags: Record<string, boolean>;');
  });

  it('compiles and accepts every observed payload', () => {
    const payloads = JSON.stringify(Array.from({ length: 24 }, (_, i) => sample(i)));
    const errors = typecheck({
      'types.ts': source,
      'check.ts': `import type { GetApiUsersByIdResponse } from './types';\nexport const ok: GetApiUsersByIdResponse[] = ${payloads};\n`,
    });
    expect(errors).toEqual([]);
  });

  it('rejects a payload that breaks the contract', () => {
    const bad = { ...sample(1), id: 'not-a-number' };
    const errors = typecheck({
      'types.ts': source,
      'check.ts': `import type { GetApiUsersByIdResponse } from './types';\nexport const bad: GetApiUsersByIdResponse = ${JSON.stringify(bad)};\n`,
    });
    expect(errors.join('\n')).toMatch(/not assignable to type 'number'/);
  });

  it('handles root arrays, primitives and empty objects', () => {
    expect(shapeToSource(infer([{ a: 1 }]), 'List')).toBe('/** List */\nexport type ListResponse = ListItem[];\n\nexport interface ListItem {\n  a: number;\n}');
    expect(shapeToSource(infer('x'), 'Str')).toBe('/** Str */\nexport type StrResponse = string;');
    expect(shapeToSource(infer({}), 'Empty')).toBe('/** Empty */\nexport type EmptyResponse = Record<string, unknown>;');
  });

  it('prefixes colliding names with the host and honours header/nameFor', () => {
    const b = learn(learn(createBaseline(), 'GET a.test /users 2xx', { a: 1 }), 'GET b.test /users 2xx', { b: 1 });
    const out = generateTypes(b, { header: false });
    expect(out).toContain('export interface ATestGetUsersResponse');
    expect(out).toContain('export interface BTestGetUsersResponse');
    expect(out.startsWith('/**')).toBe(true);
    expect(generateTypes(b, { nameFor: (k) => (k.startsWith('GET a') ? 'Alpha' : 'Beta') })).toContain('export interface AlphaResponse');
  });
});

describe('generateTypes: Zod', () => {
  const source = generateTypes(baseline(), { zod: true });

  it('matches the snapshot', () => {
    expect(source).toMatchSnapshot();
  });

  it('declares children before parents and infers types', () => {
    expect(source.indexOf('export const GetApiUsersByIdAddress')).toBeLessThan(source.indexOf('export const GetApiUsersByIdResponse'));
    expect(source).toContain('export type GetApiUsersByIdResponse = z.infer<typeof GetApiUsersByIdResponse>;');
    expect(source).toContain("import { z } from 'zod';");
    expect(source).toContain('nickname: z.string().optional(),');
    expect(source).toContain('status: z.enum(["active", "banned", "paused"]),');
    expect(source).toContain('id: z.number().int(),');
  });

  it('parses every observed payload and rejects a broken one', () => {
    const { GetApiUsersByIdResponse: schema } = loadZod(source);
    for (let i = 0; i < 24; i++) expect(() => schema.parse(sample(i))).not.toThrow();
    expect(() => schema.parse({ ...sample(1), status: 'deleted' })).toThrow('not one of');
    expect(() => schema.parse({ ...sample(1), created_at: 'yesterday' })).toThrow('does not match');
    expect(() => schema.parse({ ...sample(1), homepage: 5 })).toThrow('expected string');
    expect(() => schema.parse({ ...sample(1), nickname: 7 })).toThrow('$.nickname: expected string');
  });

  it('defines a "__proto__" property instead of setting the prototype', () => {
    const out = shapeToSource(infer(JSON.parse('{"__proto__":{"a":1},"ok":true}')), 'Odd', { zod: true });
    expect(out).toContain('["__proto__"]: OddProto,');
    const schema = loadZod(out).OddResponse;
    expect(() => schema.parse(JSON.parse('{"__proto__":{"a":1},"ok":true}'))).not.toThrow();
    expect(() => schema.parse(JSON.parse('{"__proto__":{"a":"x"},"ok":true}'))).toThrow('expected number');
  });

  it('emits catchall for objects mixing named and id-like keys', () => {
    const out = shapeToSource(infer({ name: 'x', '1001': { ok: true } }), 'Mixed', { zod: true });
    expect(out).toContain('.catchall(MixedValue)');
    const ts2 = shapeToSource(infer({ name: 'x', '1001': { ok: true } }), 'Mixed');
    expect(ts2).toContain('} & Record<string, MixedValue>;');
  });
});
