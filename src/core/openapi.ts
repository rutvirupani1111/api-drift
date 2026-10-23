import type { Baseline } from './baseline';
import { parseEndpointKey } from './endpoint';
import { mergeAll } from './merge';
import { countOf, DEFAULT_ENUM_MIN_SAMPLES, isEnum, variantsOf, type LeafShape, type Shape, type StringShape } from './shape';
import { typeNameForKey } from './typegen';
import { compareStrings, createMap, own, pascalCase, sortedKeys } from './util';

/**
 * OpenAPI 3.1 export: turn a learned baseline into a spec.
 *
 *   endpoint key                       ->  paths["/repos/{repoId}/pulls"].get.responses["2XX"]
 *   host                               ->  servers (per path when several hosts are present)
 *   shape                              ->  JSON Schema 2020-12 under components.schemas
 *
 * The output describes what was *observed*: required means "present in every
 * sampled response", enums need `enumMinSamples` observations, and no example
 * values, URLs, ids or timestamps are ever copied into the document.
 */

export interface OpenApiOptions {
  /** `info.title`. Default: the host when there is one, else "Observed API". */
  title?: string;
  /** `info.version`. Default "1.0.0". */
  version?: string;
  /** `info.description`; `false` to omit. */
  description?: string | false;
  /** Observations needed before a closed set of strings becomes an `enum`. Default 20. */
  enumMinSamples?: number;
}

/** A JSON Schema 2020-12 object (the subset api-drift emits). */
export type JsonSchema = { [keyword: string]: unknown };

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas: Record<string, JsonSchema> };
}

const STANDARD_FORMATS = new Set(['date-time', 'date', 'time', 'email', 'uri', 'uuid', 'ipv4', 'ipv6']);
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?$/i;
const IDENT = /^[A-Za-z][A-Za-z0-9]*$/;

/** JSON Schema for one shape. Exported for callers that only want schemas. */
export function shapeToJsonSchema(shape: Shape, options: { enumMinSamples?: number } = {}): JsonSchema {
  return schemaOf(shape, options.enumMinSamples ?? DEFAULT_ENUM_MIN_SAMPLES);
}

function schemaOf(shape: Shape, enumMin: number): JsonSchema {
  const variants = variantsOf(shape);
  if (variants.some((v) => v.kind === 'unknown')) return {};
  const nullable = variants.some((v) => v.kind === 'null');
  const parts = variants.filter((v) => v.kind !== 'null').map((v) => leafSchema(v, enumMin));
  if (parts.length === 0) return { type: 'null' };
  if (parts.length === 1) {
    const s = parts[0];
    if (nullable) {
      s.type = [s.type as string, 'null'];
      if (Array.isArray(s.enum)) s.enum = [...(s.enum as unknown[]), null];
    }
    return s;
  }
  // Bare `{type}` variants collapse into one type array; anything richer stays an anyOf.
  if (parts.every((p) => Object.keys(p).length === 1)) {
    return { type: [...parts.map((p) => p.type as string), ...(nullable ? ['null'] : [])] };
  }
  return { anyOf: [...parts, ...(nullable ? [{ type: 'null' }] : [])] };
}

function leafSchema(v: LeafShape, enumMin: number): JsonSchema {
  switch (v.kind) {
    case 'boolean':
    case 'integer':
    case 'number':
      return { type: v.kind };
    case 'string':
      return stringSchema(v, enumMin);
    case 'array':
      return v.items ? { type: 'array', items: schemaOf(v.items, enumMin) } : { type: 'array' };
    case 'object': {
      const out: JsonSchema = { type: 'object' };
      const keys = sortedKeys(v.properties);
      if (keys.length) {
        const props = createMap<JsonSchema>();
        const required: string[] = [];
        for (const k of keys) {
          props[k] = schemaOf(v.properties[k], enumMin);
          if (countOf(v.properties[k]) >= v.count) required.push(k);
        }
        out.properties = props;
        if (required.length) out.required = required;
      }
      if (v.additional) out.additionalProperties = schemaOf(v.additional, enumMin);
      return out;
    }
    default:
      return {};
  }
}

function stringSchema(v: StringShape, enumMin: number): JsonSchema {
  if (isEnum(v, enumMin)) return { type: 'string', enum: [...(v.values ?? [])] };
  const real = v.formats.filter((f) => f !== 'empty');
  const empty = v.formats.includes('empty');
  if (real.length === 0) return empty ? { type: 'string', maxLength: 0 } : { type: 'string' };
  if (real.length > 1 || real[0] === 'plain') return { type: 'string' };
  const f = real[0];
  const constraint: JsonSchema = STANDARD_FORMATS.has(f)
    ? { format: f }
    : f === 'base64'
      ? { contentEncoding: 'base64' }
      : { 'x-api-drift-format': f };
  return empty ? { type: 'string', anyOf: [constraint, { maxLength: 0 }] } : { type: 'string', ...constraint };
}

interface Operation {
  hosts: Set<string>;
  /** Kept query parameters per merged key: name -> value (`:id` = any). */
  queries: Array<Record<string, string>>;
  responses: Map<string, { keys: string[]; shapes: Shape[] }>;
}

/** `/repos/:id/pulls/:id` -> `{ path: '/repos/{repoId}/pulls/{pullId}', params: ['repoId', 'pullId'] }`. */
export function openApiPath(template: string): { path: string; params: string[] } {
  const params: string[] = [];
  const segs = template.split('/');
  const out = segs.map((seg, i) => {
    if (seg !== ':id') return seg;
    const prev = i > 0 ? segs[i - 1] : '';
    let base = prev && prev !== ':id' ? singular(pascalCase(prev)) : '';
    base = base ? `${base.charAt(0).toLowerCase()}${base.slice(1)}Id` : 'id';
    if (!IDENT.test(base)) base = 'id';
    let name = base;
    for (let n = 2; params.includes(name); n++) name = `${base}${n}`;
    params.push(name);
    return `{${name}}`;
  });
  return { path: out.join('/') || '/', params };
}

function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (/(?:ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function parseQuery(query: string | undefined): Record<string, string> {
  const out = createMap<string>();
  if (!query) return out;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (name && own(out, name) === undefined) out[name] = eq === -1 ? '' : pair.slice(eq + 1);
  }
  return out;
}

function serverUrl(host: string, scheme: string | undefined): string {
  return `${scheme ?? (LOCAL_HOST.test(host) ? 'http:' : 'https:')}//${host}`;
}

function schemeOf(example: string | undefined): string | undefined {
  const m = example ? /^(https?:)\/\//i.exec(example) : null;
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Build an OpenAPI 3.1 document from a baseline. Keys that are not
 * `METHOD host /path [status]` endpoint keys are skipped (see `unmappedKeys`).
 * Deterministic: the same baseline always yields the same document.
 */
export function toOpenApi(baseline: Baseline, options: OpenApiOptions = {}): OpenApiDocument {
  const enumMin = options.enumMinSamples ?? DEFAULT_ENUM_MIN_SAMPLES;
  const paths = new Map<string, { params: string[]; ops: Map<string, Operation> }>();
  const schemes = new Map<string, string | undefined>();
  for (const key of sortedKeys(baseline.endpoints)) {
    const p = parseEndpointKey(key);
    if (!p) continue;
    const entry = baseline.endpoints[key];
    const [template, query] = p.path.split('?');
    const { path, params } = openApiPath(template);
    let item = paths.get(path);
    if (!item) paths.set(path, (item = { params, ops: new Map() }));
    const method = p.method.toLowerCase();
    let op = item.ops.get(method);
    if (!op) item.ops.set(method, (op = { hosts: new Set(), queries: [], responses: new Map() }));
    op.hosts.add(p.host);
    op.queries.push(parseQuery(query));
    if (!schemes.get(p.host)) schemes.set(p.host, schemeOf(entry.example));
    const status = p.status ? p.status.toUpperCase() : 'default';
    let r = op.responses.get(status);
    if (!r) op.responses.set(status, (r = { keys: [], shapes: [] }));
    r.keys.push(key);
    r.shapes.push(entry.shape);
  }

  const hosts = [...schemes.keys()].sort(compareStrings);
  const multiHost = hosts.length > 1;
  const servers = hosts.map((h) => ({ url: serverUrl(h, schemes.get(h)) }));
  const urlOf = (h: string) => serverUrl(h, schemes.get(h));
  const schemas = createMap<JsonSchema>();
  const usedSchemas = new Set<string>();
  const usedOps = new Set<string>();
  const claim = (used: Set<string>, base: string) => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}${i}`;
    used.add(n);
    return n;
  };

  const outPaths = createMap<Record<string, unknown>>();
  for (const path of [...paths.keys()].sort(compareStrings)) {
    const item = paths.get(path)!;
    const pathItem = createMap<unknown>();
    const pathHosts = new Set<string>();
    for (const op of item.ops.values()) for (const h of op.hosts) pathHosts.add(h);
    const pathHostList = [...pathHosts].sort(compareStrings);
    if (multiHost) pathItem.servers = pathHostList.map((h) => ({ url: urlOf(h) }));
    if (item.params.length) {
      pathItem.parameters = item.params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    }
    for (const method of [...item.ops.keys()].sort(compareStrings)) {
      const op = item.ops.get(method)!;
      const firstKey = [...op.responses.values()][0].keys[0];
      const baseName = typeNameForKey(firstKey).replace(/Status[1-5]xx$/, '');
      const operation = createMap<unknown>();
      operation.operationId = claim(usedOps, `${baseName.charAt(0).toLowerCase()}${baseName.slice(1)}`);
      const queryParams = queryParameters(op.queries);
      if (queryParams.length) operation.parameters = queryParams;
      const opHosts = [...op.hosts].sort(compareStrings);
      if (multiHost && opHosts.join(' ') !== pathHostList.join(' ')) operation.servers = opHosts.map((h) => ({ url: urlOf(h) }));
      const responses = createMap<unknown>();
      for (const status of [...op.responses.keys()].sort(compareStrings)) {
        const r = op.responses.get(status)!;
        const shape = r.shapes.length === 1 ? r.shapes[0] : mergeAll(r.shapes)!;
        const name = claim(usedSchemas, `${typeNameForKey(r.keys[0])}Response`);
        schemas[name] = schemaOf(shape, enumMin);
        responses[status] = {
          description: status === 'default' ? 'Observed response' : `Observed ${status.toLowerCase()} response`,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
        };
      }
      operation.responses = responses;
      pathItem[method] = operation;
    }
    outPaths[path] = pathItem;
  }

  const title = options.title ?? (hosts.length === 1 ? hosts[0] : 'Observed API');
  const info: OpenApiDocument['info'] = { title, version: options.version ?? '1.0.0' };
  const description =
    options.description ??
    'Generated by api-drift from observed responses. Schemas describe what was seen, not what is promised: required means present in every sample. Example values are omitted for privacy.';
  if (description !== false) info.description = description;
  const doc: OpenApiDocument = { openapi: '3.1.0', info, paths: outPaths };
  if (servers.length) doc.servers = servers;
  if (Object.keys(schemas).length) doc.components = { schemas };
  return sortDocument(doc);
}

function queryParameters(queries: Array<Record<string, string>>): unknown[] {
  const names = new Set<string>();
  for (const q of queries) for (const n of Object.keys(q)) names.add(n);
  return [...names].sort(compareStrings).map((name) => {
    const values = queries.map((q) => own(q, name));
    const fixed = values.filter((v): v is string => v !== undefined);
    const schema: JsonSchema = { type: 'string' };
    if (fixed.length && !fixed.includes(':id')) schema.enum = [...new Set(fixed)].sort(compareStrings);
    return { name, in: 'query', required: values.every((v) => v !== undefined), schema };
  });
}

/** Endpoint keys of a baseline that `toOpenApi` cannot place on a path (custom keys). */
export function unmappedKeys(baseline: Baseline): string[] {
  return sortedKeys(baseline.endpoints).filter((k) => !parseEndpointKey(k));
}

const TOP_LEVEL = ['openapi', 'info', 'servers', 'paths', 'components'];

/** Sort every object's keys (top level keeps the conventional OpenAPI order). */
function sortDocument(doc: OpenApiDocument): OpenApiDocument {
  const out = createMap<unknown>();
  const rec = doc as unknown as Record<string, unknown>;
  for (const k of TOP_LEVEL) if (rec[k] !== undefined) out[k] = sortDeep(rec[k]);
  return out as unknown as OpenApiDocument;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = createMap<unknown>();
    for (const k of sortedKeys(value)) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortDeep(v);
    }
    return out;
  }
  return value;
}

/** The document as pretty JSON with a trailing newline. Key order is preserved (already sorted). */
export function openApiToJson(doc: OpenApiDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const PLAIN = /^[A-Za-z_$/][\w$./@+-]*(?:[ :][\w$./@+-]+)*$/;
const RESERVED = /^(?:y|n|yes|no|on|off|true|false|null|~)$/i;
/** `3.1.0`, `1.2.3.4`: never a number in YAML 1.1 or 1.2, so safe unquoted. */
const DOTTED = /^\d+(?:\.\d+){2,}$/;

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  return (PLAIN.test(s) && !RESERVED.test(s)) || DOTTED.test(s) ? s : JSON.stringify(s);
}

function isCollection(v: unknown): v is object {
  return v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
}

function yamlLines(value: unknown, indent: number, lines: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isCollection(item)) {
        lines.push(`${pad}- ${Array.isArray(item) ? '[]' : item && typeof item === 'object' ? '{}' : yamlScalar(item)}`);
        continue;
      }
      const start = lines.length;
      yamlLines(item, indent + 2, lines);
      lines[start] = `${pad}- ${lines[start].slice(indent + 2)}`;
    }
    return;
  }
  for (const key of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const k = yamlScalar(key);
    if (isCollection(v)) {
      lines.push(`${pad}${k}:`);
      yamlLines(v, indent + 2, lines);
    } else {
      lines.push(`${pad}${k}: ${Array.isArray(v) ? '[]' : v && typeof v === 'object' ? '{}' : yamlScalar(v)}`);
    }
  }
}

/**
 * A small YAML 1.2 emitter for JSON-compatible values (block style, keys in
 * insertion order). Strings that could be misread are written double-quoted.
 */
export function toYaml(value: unknown): string {
  if (!isCollection(value)) return `${Array.isArray(value) ? '[]' : value && typeof value === 'object' ? '{}' : yamlScalar(value)}\n`;
  const lines: string[] = [];
  yamlLines(value, 0, lines);
  return `${lines.join('\n')}\n`;
}
