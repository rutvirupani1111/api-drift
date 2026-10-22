/**
 * The shape model. A Shape describes the *structure* of observed JSON values,
 * never the values themselves (the one opt-out is enum capture, see `StringShape.values`).
 *
 * Every node carries `count`: how many values were observed at that location
 * with that kind. Counts are what let a merged shape know that a property is
 * required (present in every observed object) or optional (present in some).
 */

import { own } from './util';

export type Severity = 'breaking' | 'risky' | 'info';

/** Recognised string formats. `plain` means "no recognised format". */
export type StringFormat =
  | 'date-time'
  | 'date'
  | 'time'
  | 'email'
  | 'uri'
  | 'uuid'
  | 'ipv4'
  | 'ipv6'
  | 'hex-color'
  | 'semver'
  | 'base64'
  | 'jwt'
  | 'phone'
  | 'numeric-string'
  | 'empty'
  | 'plain';

export interface NullShape {
  kind: 'null';
  count: number;
}

export interface BooleanShape {
  kind: 'boolean';
  count: number;
}

export interface IntegerShape {
  kind: 'integer';
  count: number;
  /** Some observed value was negative. */
  negative?: true;
  /** Observed range; only recorded with `ranges: true`. */
  min?: number;
  max?: number;
}

export interface NumberShape {
  kind: 'number';
  count: number;
  /** How many of the observed values were whole numbers. */
  integral: number;
  negative?: true;
  min?: number;
  max?: number;
}

export interface StringShape {
  kind: 'string';
  count: number;
  /** Sorted set of formats seen across all observed values (`plain` = unformatted). */
  formats: StringFormat[];
  /**
   * Distinct code-like values (enum candidates). Absent once a non-code value
   * was seen, the cardinality cap was exceeded, or enum capture is disabled.
   * Treated as an enum only after `enumMinSamples` observations.
   */
  values?: string[];
  /** Observed length range; only recorded with `ranges: true`. */
  minLength?: number;
  maxLength?: number;
}

export interface ArrayShape {
  kind: 'array';
  count: number;
  minItems: number;
  maxItems: number;
  /** Merged shape of the (sampled) items; absent while only empty arrays were seen. */
  items?: Shape;
}

export interface ObjectShape {
  kind: 'object';
  count: number;
  /** Named properties. `countOf(properties[k])` is how often `k` was present. */
  properties: Record<string, Shape>;
  /** Merged shape of values under id-like keys (`{"123": {...}, "456": {...}}`). */
  additional?: Shape;
  /** More than `maxProperties` named keys: properties were not all recorded. */
  truncated?: true;
}

export interface UnionShape {
  kind: 'union';
  /** Two or more variants, at most one per slot, ordered by slot. */
  variants: Shape[];
}

/** A value that could not be inspected (depth limit, payload limit). */
export interface UnknownShape {
  kind: 'unknown';
  count: number;
}

export type Shape =
  | NullShape
  | BooleanShape
  | IntegerShape
  | NumberShape
  | StringShape
  | ArrayShape
  | ObjectShape
  | UnionShape
  | UnknownShape;

export type Kind = Shape['kind'];
export type LeafShape = Exclude<Shape, UnionShape>;

const SLOTS: Record<Kind, number> = {
  null: 0,
  boolean: 1,
  integer: 2,
  number: 2,
  string: 3,
  array: 4,
  object: 5,
  unknown: 6,
  union: -1,
};

/** Union slot of a kind. `integer` and `number` share a slot. */
export function slotOf(kind: Kind): number {
  return SLOTS[kind];
}

/** The variants of a shape: its members for a union, itself otherwise. */
export function variantsOf(shape: Shape): LeafShape[] {
  return shape.kind === 'union' ? (shape.variants as LeafShape[]) : [shape];
}

/** Total number of observations of a shape (sum of variants for unions). */
export function countOf(shape: Shape): number {
  if (shape.kind !== 'union') return shape.count;
  let n = 0;
  for (const v of shape.variants) n += countOf(v);
  return n;
}

/** Find the variant of a given kind (integer/number are matched by slot). */
export function variantOf(shape: Shape, kind: Kind): LeafShape | undefined {
  const slot = slotOf(kind);
  for (const v of variantsOf(shape)) if (slotOf(v.kind) === slot) return v;
  return undefined;
}

/** True when a shape can be null. */
export function isNullable(shape: Shape): boolean {
  return variantsOf(shape).some((v) => v.kind === 'null');
}

/** The shape without its `null` variant (undefined if it was only null). */
export function withoutNull(shape: Shape): Shape | undefined {
  const rest = variantsOf(shape).filter((v) => v.kind !== 'null');
  if (rest.length === 0) return undefined;
  return rest.length === 1 ? rest[0] : { kind: 'union', variants: rest };
}

/** Default number of observations before a closed set of strings is treated as an enum. */
export const DEFAULT_ENUM_MIN_SAMPLES = 20;
/** Default maximum number of distinct values for an enum. */
export const DEFAULT_ENUM_MAX_VALUES = 12;

/** True when a string shape has enough evidence to be treated as an enum. */
export function isEnum(shape: StringShape, enumMinSamples = DEFAULT_ENUM_MIN_SAMPLES): boolean {
  return shape.values !== undefined && shape.values.length > 0 && shape.count >= enumMinSamples;
}

/** True when property `key` was present in every observed object. */
export function isRequired(object: ObjectShape, key: string): boolean {
  const p = own(object.properties, key);
  return p !== undefined && countOf(p) >= object.count;
}

/**
 * The single effective format of a string shape, or undefined when values are
 * unformatted or mixed. `date-time|empty` means "date-times, sometimes empty".
 */
export function formatOf(shape: StringShape): string | undefined {
  const f = shape.formats;
  if (f.length === 0 || f.includes('plain')) return undefined;
  const real = f.filter((x) => x !== 'empty');
  if (real.length === 0) return 'empty';
  if (real.length > 1) return undefined;
  return f.includes('empty') ? `${real[0]}|empty` : real[0];
}
