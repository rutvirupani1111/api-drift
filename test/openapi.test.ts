import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBaseline, learn, parseBaseline, type Baseline } from '../src/core/baseline';
import { infer } from '../src/core/infer';
import { merge } from '../src/core/merge';
import {
  openApiPath,
  openApiToJson,
  shapeToJsonSchema,
  toOpenApi,
  toYaml,
  unmappedKeys,
  type OpenApiDocument,
} from '../src/core/openapi';

const SHOP_SERVERS = [{ url: 'https://api.shop.test' }];
const fixture = (name: string): Baseline =>
  parseBaseline(readFileSync(new URL(`./fixtures/${name}.baseline.json`, import.meta.url), 'utf8'));

// ------------------------------------------------------------ structural validator (no dependency)

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);
const SCHEMA_KEYWORDS = new Set([
  'type', 'enum', 'format', 'properties', 'required', 'additionalProperties', 'items', 'anyOf',
  'maxLength', 'contentEncoding', '$ref', 'x-api-drift-format',
]);

/** The OpenAPI 3.1 + JSON Schema 2020-12 rules this exporter must honour. Returns every violation. */
function validateOpenApi(doc: unknown): string[] {
  const errors: string[] = [];
  const err = (where: string, msg: string): void => {
    errors.push(`${where}: ${msg}`);
  };
  if (!isObj(doc)) return ['document is not an object'];
  if (typeof doc.openapi !== 'string' || !/^3\.1\.\d+$/.test(doc.openapi)) err('openapi', 'must be 3.1.x');
  const info = doc.info;
  if (!isObj(info)) err('info', 'required object');
  else {
    if (typeof info.title !== 'string' || !info.title) err('info.title', 'required string');
    if (typeof info.version !== 'string' || !info.version) err('info.version', 'required string');
  }
  if (doc.paths === undefined && doc.components === undefined && doc.webhooks === undefined) err('$', 'needs paths, components or webhooks');
  const schemas = isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : {};
  const servers = (where: string, list: unknown) => {
    if (!Array.isArray(list) || list.length === 0) return err(where, 'servers must be a non-empty array');
    for (const s of list) if (!isObj(s) || typeof s.url !== 'string' || !/^https?:\/\/[^/\s]+$/.test(s.url)) err(where, `bad server ${JSON.stringify(s)}`);
  };
  if (doc.servers !== undefined) servers('servers', doc.servers);

  const checkSchema = (s: unknown, where: string): void => {
    if (!isObj(s)) return err(where, 'schema must be an object');
    for (const k of Object.keys(s)) if (!SCHEMA_KEYWORDS.has(k)) err(where, `unexpected keyword ${k}`);
    if (s.example !== undefined || s.examples !== undefined) err(where, 'examples must be omitted');
    if (s.$ref !== undefined) {
      const m = typeof s.$ref === 'string' ? /^#\/components\/schemas\/(.+)$/.exec(s.$ref) : null;
      if (!m || !(m[1] in schemas)) err(where, `unresolved $ref ${String(s.$ref)}`);
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (types.length === 0 || types.some((t) => typeof t !== 'string' || !TYPES.has(t))) err(where, `bad type ${JSON.stringify(s.type)}`);
      if (new Set(types).size !== types.length) err(where, 'duplicate types');
      if (Array.isArray(s.enum) && types.includes('null') && !s.enum.includes(null)) err(where, 'nullable enum must list null');
    }
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) err(where, 'enum must be a non-empty array');
    if (s.required !== undefined) {
      if (!Array.isArray(s.required) || new Set(s.required).size !== s.required.length) err(where, 'required must be unique strings');
      else for (const r of s.required) if (!isObj(s.properties) || !(String(r) in s.properties)) err(where, `required ${String(r)} has no property`);
    }
    if (s.properties !== undefined) {
      if (!isObj(s.properties)) err(where, 'properties must be an object');
      else for (const [k, v] of Object.entries(s.properties)) checkSchema(v, `${where}.properties.${k}`);
    }
    if (s.items !== undefined) checkSchema(s.items, `${where}.items`);
    if (s.additionalProperties !== undefined) checkSchema(s.additionalProperties, `${where}.additionalProperties`);
    if (s.anyOf !== undefined) {
      if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) err(where, 'anyOf must be a non-empty array');
      else s.anyOf.forEach((x, i) => checkSchema(x, `${where}.anyOf[${i}]`));
    }
  };
  for (const [name, s] of Object.entries(schemas)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) err(`components.schemas.${name}`, 'bad component name');
    checkSchema(s, `components.schemas.${name}`);
  }

  const operationIds = new Set<string>();
  const checkParams = (list: unknown, where: string): Obj[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) return (err(where, 'parameters must be an array'), []);
    const seen = new Set<string>();
    for (const p of list) {
      if (!isObj(p) || typeof p.name !== 'string' || !['path', 'query', 'header', 'cookie'].includes(String(p.in))) {
        err(where, `bad parameter ${JSON.stringify(p)}`);
        continue;
      }
      if (seen.has(`${p.in}:${p.name}`)) err(where, `duplicate parameter ${p.name}`);
      seen.add(`${p.in}:${p.name}`);
      if (p.in === 'path' && p.required !== true) err(where, `path parameter ${p.name} must be required`);
      if ((p.schema === undefined) === (p.content === undefined)) err(where, `parameter ${p.name} needs exactly one of schema/content`);
      if (p.schema !== undefined) checkSchema(p.schema, `${where}.${p.name}`);
    }
    return list as Obj[];
  };
  if (!isObj(doc.paths)) err('paths', 'must be an object');
  else {
    const templates = new Map<string, string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      const where = `paths.${path}`;
      if (!path.startsWith('/')) err(where, 'path must start with /');
      if (path.includes(':')) err(where, 'colon parameters must be converted to {name}');
      const normalized = path.replace(/\{[^}]+\}/g, '{}');
      if (templates.has(normalized)) err(where, `same template as ${templates.get(normalized)}`);
      templates.set(normalized, path);
      if (!isObj(item)) {
        err(where, 'path item must be an object');
        continue;
      }
      const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      if (new Set(names).size !== names.length) err(where, 'duplicate template names');
      const shared = checkParams(item.parameters, `${where}.parameters`);
      if (item.servers !== undefined) servers(`${where}.servers`, item.servers);
      let ops = 0;
      for (const [method, op] of Object.entries(item)) {
        if (method === 'parameters' || method === 'servers' || method === 'summary' || method === 'description') continue;
        if (!METHODS.has(method)) {
          err(where, `unknown field ${method}`);
          continue;
        }
        ops++;
        const ow = `${where}.${method}`;
        if (!isObj(op)) {
          err(ow, 'operation must be an object');
          continue;
        }
        if (typeof op.operationId !== 'string') err(ow, 'operationId missing');
        else if (operationIds.has(op.operationId)) err(ow, `duplicate operationId ${op.operationId}`);
        else operationIds.add(op.operationId);
        const own = checkParams(op.parameters, `${ow}.parameters`);
        for (const n of names) {
          if (![...shared, ...own].some((p) => p.in === 'path' && p.name === n)) err(ow, `template {${n}} has no path parameter`);
        }
        for (const p of [...shared, ...own]) if (p.in === 'path' && !names.includes(String(p.name))) err(ow, `path parameter ${String(p.name)} not in template`);
        if (op.servers !== undefined) servers(`${ow}.servers`, op.servers);
        if (!isObj(op.responses) || Object.keys(op.responses).length === 0) {
          err(ow, 'responses must be a non-empty object');
          continue;
        }
        for (const [code, res] of Object.entries(op.responses)) {
          const rw = `${ow}.responses.${code}`;
          if (!/^(?:[1-5]XX|[1-5]\d\d|default)$/.test(code)) err(rw, 'bad status key');
          if (!isObj(res) || typeof res.description !== 'string') {
            err(rw, 'description is required');
            continue;
          }
          if (res.content !== undefined) {
            if (!isObj(res.content)) err(rw, 'content must be an object');
            else for (const [type, media] of Object.entries(res.content)) {
              if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) err(rw, `bad media type ${type}`);
              if (!isObj(media)) err(rw, 'media type must be an object');
              else if (media.schema !== undefined) checkSchema(media.schema, `${rw}.content.${type}.schema`);
            }
          }
        }
      }
      if (ops === 0) err(where, 'path item has no operations');
    }
  }
  return errors;
}

// ------------------------------------------------------------ a reader for the YAML subset toYaml emits

function parseYaml(text: string): unknown {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const QUOTED = /^"(?:[^"\\]|\\.)*"/;
  const scalar = (s: string): unknown => {
    if (s.startsWith('"')) return JSON.parse(s);
    if (s === '[]') return [];
    if (s === '{}') return {};
    if (s === 'null') return null;
    if (s === 'true' || s === 'false') return s === 'true';
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s)) return Number(s);
    return s;
  };
  /** `key: value` / `key:` -> [key, value | undefined]; a bare scalar -> undefined. */
  const splitKey = (body: string): [string, string | undefined] | undefined => {
    const q = QUOTED.exec(body);
    if (q) {
      const rest = body.slice(q[0].length);
      if (rest === ':') return [JSON.parse(q[0]) as string, undefined];
      if (rest.startsWith(': ')) return [JSON.parse(q[0]) as string, rest.slice(2)];
      return undefined;
    }
    if (body.endsWith(':')) return [body.slice(0, -1), undefined];
    const at = body.indexOf(': ');
    return at === -1 ? undefined : [body.slice(0, at), body.slice(at + 2)];
  };
  const block = (indent: number): unknown => {
    if (lines[i].slice(indent).startsWith('- ')) {
      const arr: unknown[] = [];
      while (i < lines.length && indentOf(lines[i]) === indent && lines[i].slice(indent).startsWith('- ')) {
        const rest = lines[i].slice(indent + 2);
        if (!rest.startsWith('- ') && splitKey(rest) === undefined) {
          arr.push(scalar(rest));
          i++;
          continue;
        }
        lines[i] = ' '.repeat(indent + 2) + rest;
        arr.push(block(indent + 2));
      }
      return arr;
    }
    const obj: Obj = {};
    while (i < lines.length && indentOf(lines[i]) === indent && !lines[i].slice(indent).startsWith('- ')) {
      const kv = splitKey(lines[i].slice(indent));
      if (!kv) throw new Error(`not a mapping line: ${lines[i]}`);
      i++;
      obj[kv[0]] = kv[1] === undefined ? block(indentOf(lines[i])) : scalar(kv[1]);
    }
    return obj;
  };
  return block(0);
}

// ------------------------------------------------------------ tests

describe('toOpenApi: fixture baselines', () => {
  const shop = toOpenApi(fixture('openapi-shop'));
  const multi = toOpenApi(fixture('openapi-multi'), { title: 'Shop (observed)', version: '2026.10' });

  it('matches the JSON snapshots', () => {
    expect(openApiToJson(shop)).toMatchSnapshot();
    expect(openApiToJson(multi)).toMatchSnapshot();
  });

  it('matches the YAML snapshot', () => {
    expect(toYaml(multi)).toMatchSnapshot();
  });

  it('is structurally valid OpenAPI 3.1', () => {
    expect(validateOpenApi(shop)).toEqual([]);
    expect(validateOpenApi(multi)).toEqual([]);
    expect(validateOpenApi(JSON.parse(openApiToJson(multi)))).toEqual([]);
  });

  it('YAML reads back to the same document', () => {
    expect(parseYaml(toYaml(shop))).toEqual(JSON.parse(openApiToJson(shop)));
    expect(parseYaml(toYaml(multi))).toEqual(JSON.parse(openApiToJson(multi)));
  });

  it('the validator catches what it claims to check', () => {
    const broken = JSON.parse(openApiToJson(multi)) as Obj & { paths: Record<string, Obj> };
    delete (broken.info as Obj).version;
    const item = broken.paths['/api/users/{userId}'];
    delete item.parameters;
    ((item.get as Obj).responses as Obj)['2XX'] = { content: {} };
    ((broken.components as Obj).schemas as Obj).Bad = { type: ['string', 'null'], enum: ['a'], example: 'x' };
    const errors = validateOpenApi(broken).join('\n');
    expect(errors).toContain('info.version: required string');
    expect(errors).toContain('template {userId} has no path parameter');
    expect(errors).toContain('description is required');
    expect(errors).toContain('nullable enum must list null');
    expect(errors).toContain('unexpected keyword example');
  });

  it('servers come from hosts, schemes from the stored example, per path when hosts differ', () => {
    expect(shop.servers).toEqual(SHOP_SERVERS);
    expect(multi.servers).toEqual([
      { url: 'https://admin.shop.test' },
      { url: 'https://api.shop.test' },
      { url: 'http://localhost:3000' },
      { url: 'https://staging.shop.test' },
    ]);
    const users = multi.paths['/api/users/{userId}'] as Obj;
    expect(users.servers).toEqual([{ url: 'https://api.shop.test' }, { url: 'https://staging.shop.test' }]);
    expect((multi.paths['/health'] as Obj).servers).toEqual([{ url: 'http://localhost:3000' }]);
  });

  it('turns :id segments into named path parameters and status classes into ranges', () => {
    const items = multi.paths['/api/orders/{orderId}/items/{itemId}'] as Obj;
    expect(items.parameters).toEqual([
      { in: 'path', name: 'orderId', required: true, schema: { type: 'string' } },
      { in: 'path', name: 'itemId', required: true, schema: { type: 'string' } },
    ]);
    const get = (multi.paths['/api/users/{userId}'] as Obj).get as Obj;
    expect(Object.keys(get.responses as Obj)).toEqual(['2XX', '4XX']);
    expect(get.operationId).toBe('getApiUsersById');
  });

  it('kept query keys become query parameters, fixed values an enum', () => {
    const search = (multi.paths['/api/search'] as Obj).get as Obj;
    expect(search.parameters).toEqual([
      { in: 'query', name: 'page', required: false, schema: { type: 'string' } },
      { in: 'query', name: 'type', required: true, schema: { enum: ['products', 'users'], type: 'string' } },
    ]);
  });

  it('never copies example values, URLs or timestamps into the document', () => {
    const text = openApiToJson(multi) + openApiToJson(shop);
    for (const leak of ['user1@shop.test', 'Mumbai', '400001', 'secret', '2026-10-2', '/api/users/1', 'ord_']) expect(text).not.toContain(leak);
  });

  it('lists custom keys it cannot place', () => {
    expect(unmappedKeys(fixture('openapi-multi'))).toEqual(['users']);
  });
});

describe('toOpenApi: schemas', () => {
  const user = (i: number) => ({
    id: i,
    status: ['active', 'paused'][i % 2],
    tier: i % 12 ? 'gold' : null,
    seen: i % 2 ? '' : '2026-10-23T02:40:00Z',
    note: i % 2 ? 'x' : undefined,
    ref: i % 2 ? i : 'r',
    data: i % 2 ? { a: 1 } : [1],
    empty: [],
  });
  const shape = [...Array(24).keys()].map((i) => infer(user(i))).reduce((a, b) => merge(a, b));
  const s = shapeToJsonSchema(shape) as Obj & { properties: Record<string, Obj> };

  it('maps types, formats, enums, nullability and presence', () => {
    expect(s.type).toBe('object');
    expect(s.required).toEqual(['data', 'empty', 'id', 'ref', 'seen', 'status', 'tier']);
    expect(s.properties.id).toEqual({ type: 'integer' });
    expect(s.properties.status).toEqual({ type: 'string', enum: ['active', 'paused'] });
    expect(s.properties.tier).toEqual({ type: ['string', 'null'], enum: ['gold', null] });
    expect(s.properties.seen).toEqual({ type: 'string', anyOf: [{ format: 'date-time' }, { maxLength: 0 }] });
    expect(s.properties.note).toEqual({ type: 'string' });
    expect(s.properties.ref).toEqual({ type: ['integer', 'string'] });
    expect(s.properties.data).toEqual({ anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }] });
    expect(s.properties.empty).toEqual({ type: 'array' });
  });

  it('respects enumMinSamples and maps dictionaries to additionalProperties', () => {
    expect((shapeToJsonSchema(shape, { enumMinSamples: 100 }) as typeof s).properties.status).toEqual({ type: 'string' });
    expect(shapeToJsonSchema(infer({ '101': { ok: true }, '202': { ok: false } }))).toEqual({
      type: 'object',
      additionalProperties: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    expect(shapeToJsonSchema(infer(null))).toEqual({ type: 'null' });
    expect(shapeToJsonSchema({ kind: 'string', count: 3, formats: ['base64'] })).toEqual({ type: 'string', contentEncoding: 'base64' });
    expect(shapeToJsonSchema({ kind: 'string', count: 3, formats: ['semver'] })).toEqual({ type: 'string', 'x-api-drift-format': 'semver' });
    expect(shapeToJsonSchema({ kind: 'string', count: 3, formats: ['empty'] })).toEqual({ type: 'string', maxLength: 0 });
    expect(shapeToJsonSchema({ kind: 'unknown', count: 1 })).toEqual({});
  });

  it('names path parameters after the collection and keeps them unique', () => {
    expect(openApiPath('/repos/:id/pulls/:id')).toEqual({ path: '/repos/{repoId}/pulls/{pullId}', params: ['repoId', 'pullId'] });
    expect(openApiPath('/:id/:id')).toEqual({ path: '/{id}/{id2}', params: ['id', 'id2'] });
    expect(openApiPath('/categories/:id/addresses/:id/status/:id').params).toEqual(['categoryId', 'addressId', 'statusId']);
    expect(openApiPath('/')).toEqual({ path: '/', params: [] });
  });

  it('is deterministic regardless of learning order', () => {
    const keys = ['GET a.test /x/:id 2xx', 'GET a.test /x/:id 5xx', 'POST b.test /y 2xx'];
    const build = (order: string[]) => {
      let b = createBaseline();
      for (const k of order) b = learn(b, k, { k, n: 1 }, { at: 0 });
      return openApiToJson(toOpenApi(b));
    };
    expect(build(keys)).toBe(build([...keys].reverse()));
    const doc: OpenApiDocument = JSON.parse(build(keys));
    expect(Object.keys(doc)).toEqual(['openapi', 'info', 'servers', 'paths', 'components']);
    expect(doc.info.title).toBe('Observed API');
  });

  it('an empty baseline is still a valid document', () => {
    const doc = toOpenApi(createBaseline(), { description: false });
    expect(doc).toEqual({ openapi: '3.1.0', info: { title: 'Observed API', version: '1.0.0' }, paths: {} });
    expect(validateOpenApi(doc)).toEqual([]);
  });
});

describe('toYaml', () => {
  it('quotes anything a YAML reader could misread', () => {
    const value = {
      plain: 'hello world',
      url: 'https://api.shop.test',
      yes: 'yes',
      num: '42',
      semver: '3.1.0',
      float: '1.5',
      colon: 'a: b',
      hash: 'a #b',
      lead: '-x',
      empty: '',
      multi: 'line\nbreak',
      '2XX': 1.5,
      $ref: '#/components/schemas/X',
      list: [null, true, [], {}, ['nested'], { k: 'v', w: [1] }],
      none: {},
    };
    const yaml = toYaml(value);
    expect(yaml).toContain('plain: hello world\n');
    expect(yaml).toContain('url: https://api.shop.test\n');
    expect(yaml).toContain('"yes": "yes"\n');
    expect(yaml).toContain('num: "42"\n');
    expect(yaml).toContain('"2XX": 1.5\n');
    expect(yaml).toContain('semver: 3.1.0\n');
    expect(yaml).toContain('float: "1.5"\n');
    expect(yaml).toContain('$ref: "#/components/schemas/X"\n');
    expect(yaml).toContain('none: {}\n');
    expect(parseYaml(yaml)).toEqual(value);
    expect(toYaml([])).toBe('[]\n');
    expect(toYaml('x')).toBe('x\n');
  });
});
