import { VERSION } from '../version';
import { diff, makeChange, sortChanges, type Change, type DiffOptions } from './diff';
import { parseEndpointKey, redactUrl, routeOf } from './endpoint';
import { infer, type InferOptions } from './infer';
import { merge, mergeAll, type MergeOptions } from './merge';
import { countOf, type Shape, type StringFormat } from './shape';
import { compareStrings, createMap, own, sortedKeys } from './util';

/**
 * A baseline is the learned contract of every endpoint, keyed by endpoint key.
 * It is the on-disk format of `.api-drift/baseline.json` and of every store.
 */
export interface BaselineEntry {
  /** An example URL for the endpoint (query string removed). */
  example?: string;
  /** Number of payloads merged into `shape`. */
  samples: number;
  firstSeen: string;
  lastSeen: string;
  /** Learning has stopped (auto mode); drift is reported against this entry. */
  frozen?: boolean;
  shape: Shape;
}

export interface Baseline {
  version: 1;
  generator?: string;
  updatedAt?: string;
  endpoints: Record<string, BaselineEntry>;
}

export class BaselineError extends Error {
  override name = 'BaselineError';
}

export function createBaseline(): Baseline {
  return { version: 1, generator: `api-drift@${VERSION}`, endpoints: createMap() };
}

function iso(at: Date | string | number | undefined): string {
  if (at === undefined) return new Date().toISOString();
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export interface LearnOptions extends MergeOptions {
  /** When the sample was observed. Default: now. */
  at?: Date | string | number;
  /** A URL to remember as the example (its query string is dropped). */
  example?: string;
}

/** Create or extend an entry with an already-inferred shape. */
export function learnEntry(prev: BaselineEntry | undefined, shape: Shape, options: LearnOptions = {}): BaselineEntry {
  const at = iso(options.at);
  const entry: BaselineEntry = prev
    ? {
        ...prev,
        samples: prev.samples + countOf(shape),
        firstSeen: prev.firstSeen < at ? prev.firstSeen : at,
        lastSeen: prev.lastSeen > at ? prev.lastSeen : at,
        shape: merge(prev.shape, shape, options),
      }
    : { samples: countOf(shape), firstSeen: at, lastSeen: at, shape };
  if (!entry.example && options.example) entry.example = redactUrl(options.example);
  return orderEntry(entry);
}

/** Return a new baseline with `shape` merged into endpoint `key`. */
export function learnShape(baseline: Baseline, key: string, shape: Shape, options: LearnOptions = {}): Baseline {
  const endpoints = createMap<BaselineEntry>();
  for (const k of Object.keys(baseline.endpoints)) endpoints[k] = baseline.endpoints[k];
  endpoints[key] = learnEntry(own(baseline.endpoints, key), shape, options);
  return { ...baseline, updatedAt: iso(options.at), endpoints };
}

/** Return a new baseline with one observed payload learned under `key`. */
export function learn(baseline: Baseline, key: string, payload: unknown, options: LearnOptions & InferOptions = {}): Baseline {
  return learnShape(baseline, key, infer(payload, options), options);
}

/** Merge two baselines endpoint by endpoint. */
export function mergeBaselines(a: Baseline, b: Baseline, options: MergeOptions = {}): Baseline {
  const endpoints = createMap<BaselineEntry>();
  for (const key of [...new Set([...Object.keys(a.endpoints), ...Object.keys(b.endpoints)])].sort(compareStrings)) {
    const x = own(a.endpoints, key);
    const y = own(b.endpoints, key);
    if (x && y) {
      endpoints[key] = orderEntry({
        example: x.example ?? y.example,
        samples: x.samples + y.samples,
        firstSeen: x.firstSeen < y.firstSeen ? x.firstSeen : y.firstSeen,
        lastSeen: x.lastSeen > y.lastSeen ? x.lastSeen : y.lastSeen,
        frozen: x.frozen || y.frozen || undefined,
        shape: merge(x.shape, y.shape, options),
      });
    } else endpoints[key] = (x ?? y)!;
  }
  const updated = [a.updatedAt, b.updatedAt].filter(Boolean).sort().pop();
  return { version: 1, generator: `api-drift@${VERSION}`, updatedAt: updated, endpoints };
}

export interface EndpointDiff {
  key: string;
  status: 'ok' | 'drift' | 'added' | 'removed';
  changes: Change[];
}

/**
 * Diff two baselines. Endpoints present on one side only are reported as
 * `endpoint-added` / `endpoint-removed`; a route whose only status class changed
 * (2xx -> 5xx) is reported as `status-changed`.
 */
export function diffBaselines(a: Baseline, b: Baseline, options: DiffOptions = {}): EndpointDiff[] {
  const out: EndpointDiff[] = [];
  const aKeys = sortedKeys(a.endpoints);
  const bKeys = sortedKeys(b.endpoints);
  const onlyA = aKeys.filter((k) => !own(b.endpoints, k));
  const consumed = new Set<string>();
  for (const key of bKeys) {
    const x = own(a.endpoints, key);
    const y = b.endpoints[key];
    if (x) {
      const changes = diff(x.shape, y.shape, options);
      out.push({ key, status: changes.length ? 'drift' : 'ok', changes });
      continue;
    }
    const route = routeOf(key);
    const previous = onlyA.find((k) => !consumed.has(k) && routeOf(k) === route && k !== key);
    if (previous && parseEndpointKey(key)?.status) {
      consumed.add(previous);
      const from = parseEndpointKey(previous)?.status ?? '?';
      const to = parseEndpointKey(key)?.status ?? '?';
      const change = makeChange('status-changed', '$', `status changed from ${from} to ${to}`, from, to, options);
      out.push({ key, status: change ? 'drift' : 'ok', changes: change ? [change] : [] });
      continue;
    }
    const change = makeChange('endpoint-added', '$', 'endpoint not in the first baseline', undefined, 'present', options);
    out.push({ key, status: 'added', changes: change ? [change] : [] });
  }
  for (const key of onlyA) {
    if (consumed.has(key)) continue;
    const change = makeChange('endpoint-removed', '$', 'endpoint not in the second baseline', 'present', undefined, options);
    out.push({ key, status: 'removed', changes: change ? [change] : [] });
  }
  for (const d of out) sortChanges(d.changes);
  return out.sort((x, y) => compareStrings(x.key, y.key));
}

/** True when a value looks like a serialized baseline. */
export function isBaseline(value: unknown): value is Baseline {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Baseline).version === 1 &&
    !!(value as Baseline).endpoints &&
    typeof (value as Baseline).endpoints === 'object'
  );
}

/** Parse and validate a baseline (string or already-parsed JSON). Throws BaselineError. */
export function parseBaseline(input: string | unknown): Baseline {
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      throw new BaselineError(`Baseline is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BaselineError('Baseline must be a JSON object');
  const raw = data as Record<string, unknown>;
  if (raw.version !== 1) throw new BaselineError(`Unsupported baseline version: ${JSON.stringify(raw.version)} (expected 1)`);
  if (!raw.endpoints || typeof raw.endpoints !== 'object' || Array.isArray(raw.endpoints)) {
    throw new BaselineError('Baseline is missing an "endpoints" object');
  }
  const endpoints = createMap<BaselineEntry>();
  const src = raw.endpoints as Record<string, unknown>;
  for (const key of sortedKeys(src)) endpoints[key] = normalizeEntry(src[key], key);
  const out: Baseline = { version: 1, endpoints };
  if (typeof raw.generator === 'string') out.generator = raw.generator;
  if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt;
  return out;
}

/** Validate one untrusted baseline entry (as stored by a custom store). Throws BaselineError. */
export function normalizeEntry(value: unknown, key = '?'): BaselineEntry {
  if (!value || typeof value !== 'object') throw new BaselineError(`Endpoint "${key}" is not an object`);
  const e = value as Record<string, unknown>;
  const shape = normalizeShape(e.shape, `endpoints["${key}"].shape`);
  const now = new Date().toISOString();
  return orderEntry({
    example: typeof e.example === 'string' ? e.example : undefined,
    samples: typeof e.samples === 'number' && e.samples >= 0 ? e.samples : countOf(shape),
    firstSeen: typeof e.firstSeen === 'string' ? e.firstSeen : now,
    lastSeen: typeof e.lastSeen === 'string' ? e.lastSeen : now,
    frozen: e.frozen === true ? true : undefined,
    shape,
  });
}

function orderEntry(e: BaselineEntry): BaselineEntry {
  const out = {} as BaselineEntry;
  if (e.example !== undefined) out.example = e.example;
  out.samples = e.samples;
  out.firstSeen = e.firstSeen;
  out.lastSeen = e.lastSeen;
  if (e.frozen) out.frozen = true;
  out.shape = e.shape;
  return out;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function strings(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].sort(compareStrings) : [];
}

/**
 * Validate an untrusted shape (e.g. from a baseline file) and rebuild it in
 * canonical form: fixed field order, sorted keys and sets, merged union slots.
 */
const KINDS = ['null', 'boolean', 'integer', 'number', 'string', 'array', 'object', 'unknown'];

export function normalizeShape(value: unknown, path = '$'): Shape {
  if (!value || typeof value !== 'object') throw new BaselineError(`Invalid shape at ${path}`);
  const s = value as Record<string, unknown>;
  const k = s.kind as string;
  if (k === 'union') {
    if (!Array.isArray(s.variants) || s.variants.length === 0) throw new BaselineError(`Union without variants at ${path}`);
    return mergeAll(s.variants.map((v, i) => normalizeShape(v, `${path}|${i}`)))!;
  }
  if (!KINDS.includes(k)) throw new BaselineError(`Unknown shape kind ${JSON.stringify(s.kind)} at ${path}`);
  // Field order matters: it is the order `infer` and `merge` build, so files stay stable.
  const out: Record<string, unknown> = { kind: k, count: num(s.count, 1) };
  const copy = (field: string) => {
    const v = optNum(s[field]);
    if (v !== undefined) out[field] = v;
  };
  if (k === 'number') out.integral = num(s.integral, 0);
  if (k === 'integer' || k === 'number') {
    if (s.negative === true) out.negative = true;
    copy('min');
    copy('max');
  } else if (k === 'string') {
    const formats = strings(s.formats) as StringFormat[];
    out.formats = formats.length ? formats : ['plain'];
    if (Array.isArray(s.values)) out.values = strings(s.values);
    copy('minLength');
    copy('maxLength');
  } else if (k === 'array') {
    out.minItems = num(s.minItems, 0);
    out.maxItems = num(s.maxItems, 0);
    if (s.items !== undefined) out.items = normalizeShape(s.items, `${path}[]`);
  } else if (k === 'object') {
    const props = s.properties && typeof s.properties === 'object' ? (s.properties as Record<string, unknown>) : {};
    const properties = createMap<Shape>();
    for (const key of sortedKeys(props)) properties[key] = normalizeShape(props[key], `${path}.${key}`);
    out.properties = properties;
    if (s.additional !== undefined) out.additional = normalizeShape(s.additional, `${path}.*`);
    if (s.truncated === true) out.truncated = true;
  }
  return out as unknown as Shape;
}

/** Serialize a baseline deterministically (sorted endpoints, canonical shapes, trailing newline). */
export function serializeBaseline(baseline: Baseline): string {
  const endpoints = createMap<BaselineEntry>();
  for (const k of sortedKeys(baseline.endpoints)) {
    const e = baseline.endpoints[k];
    endpoints[k] = orderEntry({ ...e, shape: normalizeShape(e.shape) });
  }
  const out: Baseline = { version: 1, generator: `api-drift@${VERSION}`, endpoints };
  if (baseline.updatedAt) out.updatedAt = baseline.updatedAt;
  return `${JSON.stringify({ version: out.version, generator: out.generator, updatedAt: out.updatedAt, endpoints }, null, 2)}\n`;
}
