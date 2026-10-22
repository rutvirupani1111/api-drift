import { isDynamicKey } from './endpoint';
import { detectFormat, isCodeLike } from './formats';
import { merge } from './merge';
import {
  DEFAULT_ENUM_MAX_VALUES,
  type ArrayShape,
  type IntegerShape,
  type LeafShape,
  type NumberShape,
  type ObjectShape,
  type Shape,
  type StringShape,
} from './shape';
import { createMap, joinPath, sortedKeys } from './util';

export interface InferOptions {
  /** Containers nested deeper than this become `unknown`. Default 20. */
  maxDepth?: number;
  /** Named properties recorded per object; the rest are ignored with a warning. Default 500. */
  maxProperties?: number;
  /** Array items (and id-keyed values) sampled per container, evenly spaced. Default 50. */
  maxArrayItems?: number;
  /** Abort inference (result: `unknown`) once this many bytes have been inspected. Default 1 MB. */
  maxPayloadBytes?: number;
  /** Capture low-cardinality code-like strings as enum candidates. Default true. */
  enums?: boolean;
  /** Distinct values kept per enum candidate. Default 12. */
  enumMaxValues?: number;
  /**
   * Keys whose values are never captured as enum values. Defaults to a list of
   * personal and secret words (name, email, token, address, id, ...). `false` disables it.
   */
  enumExclude?: RegExp | ((key: string) => boolean) | false;
  /** Detect string formats (date-time, email, uuid, ...). Default true. */
  formats?: boolean;
  /** Record numeric min/max and string length ranges. Off by default: ranges are values. */
  ranges?: boolean;
  /** Collapse id-like object keys (`{"123": {...}}`) into one `additional` shape. Default true. */
  dynamicKeys?: boolean;
  /** Called when a size guard trims or skips part of a payload. */
  onWarning?: (warning: InferWarning) => void;
}

export interface InferWarning {
  code: 'max-depth' | 'max-properties' | 'payload-too-large';
  path: string;
  message: string;
}

export const DEFAULT_LIMITS = {
  maxDepth: 20,
  maxProperties: 500,
  maxArrayItems: 50,
  maxPayloadBytes: 1_000_000,
} as const;

const PRIVATE_WORDS = new Set(
  (
    'id ids uuid guid key apikey token secret password passwd pwd pass auth authorization hash signature sig ' +
    'nonce salt otp pin email mail phone mobile tel fax name names username login handle nick nickname surname ' +
    'address street city zip postal postcode ssn dob birthday birthdate ip host hostname domain lat lng lon ' +
    'latitude longitude url uri href link path slug title description text body message comment note bio ' +
    'avatar image photo picture sha etag cursor session cookie iban cvv cvc owner author assignee creator ' +
    'sender recipient customer'
  ).split(' '),
);

/** Default enum exclusion: true when any word of the key is personal or secret. */
export function isPrivateKey(key: string): boolean {
  if (!key) return false;
  const words = key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/);
  return words.some((w) => PRIVATE_WORDS.has(w));
}

interface Ctx {
  maxDepth: number;
  maxProperties: number;
  maxArrayItems: number;
  budget: number;
  limit: number;
  enums: boolean;
  enumMax: number;
  formats: boolean;
  ranges: boolean;
  dynamicKeys: boolean;
  excluded: (key: string) => boolean;
  warned: Set<string>;
  onWarning?: (w: InferWarning) => void;
}

const ABORT = Symbol('abort');

/**
 * Infer the shape of a JSON-compatible value. Never throws for data reasons:
 * size guards degrade to `unknown` nodes and report through `onWarning`.
 */
export function infer(value: unknown, options: InferOptions = {}): Shape {
  const ex = options.enumExclude;
  const ctx: Ctx = {
    maxDepth: options.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    maxProperties: options.maxProperties ?? DEFAULT_LIMITS.maxProperties,
    maxArrayItems: Math.max(1, options.maxArrayItems ?? DEFAULT_LIMITS.maxArrayItems),
    budget: options.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes,
    limit: options.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes,
    enums: options.enums ?? true,
    enumMax: options.enumMaxValues ?? DEFAULT_ENUM_MAX_VALUES,
    formats: options.formats ?? true,
    ranges: options.ranges ?? false,
    dynamicKeys: options.dynamicKeys ?? true,
    excluded: ex === false ? () => false : ex instanceof RegExp ? (k) => ex.test(k) : (ex ?? isPrivateKey),
    warned: new Set(),
    onWarning: options.onWarning,
  };
  try {
    return node(value, ctx, 0, '$', '');
  } catch (e) {
    if (e === ABORT) return { kind: 'unknown', count: 1 };
    throw e;
  }
}

function warn(ctx: Ctx, code: InferWarning['code'], path: string, message: string): void {
  if (ctx.warned.has(code)) return;
  ctx.warned.add(code);
  ctx.onWarning?.({ code, path, message });
}

function spend(ctx: Ctx, bytes: number): void {
  ctx.budget -= bytes;
  if (ctx.budget < 0) {
    warn(ctx, 'payload-too-large', '$', `payload exceeds maxPayloadBytes (${ctx.limit}); skipped`);
    throw ABORT;
  }
}

function node(v: unknown, ctx: Ctx, depth: number, path: string, key: string): LeafShape {
  switch (typeof v) {
    case 'boolean':
      spend(ctx, 5);
      return { kind: 'boolean', count: 1 };
    case 'number':
      spend(ctx, 8);
      return numeric(v, ctx);
    case 'bigint':
      spend(ctx, 8);
      return numeric(Number(v), ctx);
    case 'string':
      spend(ctx, v.length + 2);
      return string(v, ctx, key);
    case 'object':
      if (v !== null) break;
      spend(ctx, 4);
      return { kind: 'null', count: 1 };
    default:
      // undefined, functions and symbols serialise as null (or vanish) in JSON
      spend(ctx, 4);
      return { kind: 'null', count: 1 };
  }
  const toJSON = (v as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    const json: unknown = toJSON.call(v);
    if (json !== v) return node(json, ctx, depth + 1, path, key);
  }
  if (depth >= ctx.maxDepth) {
    warn(ctx, 'max-depth', path, `nesting deeper than maxDepth (${ctx.maxDepth}); recorded as unknown`);
    return { kind: 'unknown', count: 1 };
  }
  return Array.isArray(v) ? array(v, ctx, depth, path, key) : object(v as Record<string, unknown>, ctx, depth, path, key);
}

function numeric(v: number, ctx: Ctx): IntegerShape | NumberShape {
  const out: IntegerShape | NumberShape = Number.isInteger(v)
    ? { kind: 'integer', count: 1 }
    : { kind: 'number', count: 1, integral: 0 };
  if (v < 0) out.negative = true;
  if (ctx.ranges && Number.isFinite(v)) {
    out.min = v;
    out.max = v;
  }
  return out;
}

function string(v: string, ctx: Ctx, key: string): StringShape {
  const format = ctx.formats ? detectFormat(v) : v.length === 0 ? 'empty' : 'plain';
  const out: StringShape = { kind: 'string', count: 1, formats: [format] };
  if (ctx.enums && format === 'plain' && isCodeLike(v) && !ctx.excluded(key)) out.values = [v];
  if (ctx.ranges) {
    out.minLength = v.length;
    out.maxLength = v.length;
  }
  return out;
}

function array(arr: readonly unknown[], ctx: Ctx, depth: number, path: string, key: string): ArrayShape {
  spend(ctx, 2);
  const n = arr.length;
  const out: ArrayShape = { kind: 'array', count: 1, minItems: n, maxItems: n };
  if (n === 0) return out;
  const take = Math.min(n, ctx.maxArrayItems);
  const itemPath = `${path}[]`;
  let items: Shape | undefined;
  for (let i = 0; i < take; i++) {
    // Evenly spaced sample that always includes the first and the last item.
    const idx = n === take ? i : take === 1 ? 0 : Math.round((i * (n - 1)) / (take - 1));
    const s = node(arr[idx], ctx, depth + 1, itemPath, key);
    items = items ? merge(items, s, { enumMaxValues: ctx.enumMax }) : s;
  }
  out.items = items;
  return out;
}

function object(obj: Record<string, unknown>, ctx: Ctx, depth: number, path: string, key: string): ObjectShape {
  spend(ctx, 2);
  const props = createMap<Shape>();
  let named = 0;
  let dynamic = 0;
  let truncated = false;
  let additional: Shape | undefined;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    spend(ctx, k.length + 4);
    if (ctx.dynamicKeys && isDynamicKey(k)) {
      if (dynamic++ < ctx.maxArrayItems) {
        const s = node(v, ctx, depth + 1, `${path}.*`, key);
        additional = additional ? merge(additional, s, { enumMaxValues: ctx.enumMax }) : s;
      }
      continue;
    }
    if (named >= ctx.maxProperties) {
      truncated = true;
      continue;
    }
    named++;
    props[k] = node(v, ctx, depth + 1, joinPath(path, k), k);
  }
  const properties = createMap<Shape>();
  for (const k of sortedKeys(props)) properties[k] = props[k];
  const out: ObjectShape = { kind: 'object', count: 1, properties };
  if (additional) out.additional = additional;
  if (truncated) {
    out.truncated = true;
    warn(ctx, 'max-properties', path, `more than maxProperties (${ctx.maxProperties}) keys; the rest were ignored`);
  }
  return out;
}
