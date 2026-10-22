import {
  DEFAULT_ENUM_MAX_VALUES,
  slotOf,
  variantsOf,
  type ArrayShape,
  type IntegerShape,
  type LeafShape,
  type NumberShape,
  type ObjectShape,
  type Shape,
  type StringShape,
} from './shape';
import { createMap, own, sortedKeys, unionSorted } from './util';

export interface MergeOptions {
  /** Enum candidates are dropped once more than this many distinct values are seen. Default 12. */
  enumMaxValues?: number;
}

/**
 * Merge two shapes into one that describes every value either one described.
 *
 * Algebra: the structural part of a shape is a join-semilattice, so `merge` is
 * commutative, associative and idempotent on structure (types, formats,
 * required/optional ratios, enum sets). Observation counts are additive:
 * `merge(a, a)` is `a` with every count doubled, which is exactly what learning
 * the same evidence twice should mean.
 */
export function merge(a: Shape, b: Shape, options: MergeOptions = {}): Shape {
  return mergeShapes(a, b, options.enumMaxValues ?? DEFAULT_ENUM_MAX_VALUES);
}

/** Merge a list of shapes left to right. Returns undefined for an empty list. */
export function mergeAll(shapes: readonly Shape[], options: MergeOptions = {}): Shape | undefined {
  let acc: Shape | undefined;
  for (const s of shapes) acc = acc ? merge(acc, s, options) : s;
  return acc;
}

function mergeShapes(a: Shape, b: Shape, max: number): Shape {
  if (a.kind !== 'union' && b.kind !== 'union' && slotOf(a.kind) === slotOf(b.kind)) {
    return mergeLeaf(a, b, max);
  }
  const slots: (LeafShape | undefined)[] = [];
  for (const v of variantsOf(a).concat(variantsOf(b))) {
    const s = slotOf(v.kind);
    const prev = slots[s];
    slots[s] = prev ? mergeLeaf(prev, v, max) : v;
  }
  const variants = slots.filter((v): v is LeafShape => v !== undefined);
  return variants.length === 1 ? variants[0] : { kind: 'union', variants };
}

function mergeLeaf(a: LeafShape, b: LeafShape, max: number): LeafShape {
  switch (a.kind) {
    case 'integer':
    case 'number':
      return mergeNumeric(a, b as IntegerShape | NumberShape);
    case 'string':
      return mergeString(a, b as StringShape, max);
    case 'array':
      return mergeArray(a, b as ArrayShape, max);
    case 'object':
      return mergeObject(a, b as ObjectShape, max);
    default:
      return { kind: a.kind, count: a.count + b.count } as LeafShape;
  }
}

function minOf(x: number | undefined, y: number | undefined): number | undefined {
  return x === undefined ? y : y === undefined ? x : Math.min(x, y);
}

function maxOf(x: number | undefined, y: number | undefined): number | undefined {
  return x === undefined ? y : y === undefined ? x : Math.max(x, y);
}

const integralOf = (s: IntegerShape | NumberShape): number => (s.kind === 'integer' ? s.count : s.integral);

function mergeNumeric(a: IntegerShape | NumberShape, b: IntegerShape | NumberShape): IntegerShape | NumberShape {
  const count = a.count + b.count;
  const out: IntegerShape | NumberShape =
    a.kind === 'integer' && b.kind === 'integer'
      ? { kind: 'integer', count }
      : { kind: 'number', count, integral: integralOf(a) + integralOf(b) };
  if (a.negative || b.negative) out.negative = true;
  const lo = minOf(a.min, b.min);
  const hi = maxOf(a.max, b.max);
  if (lo !== undefined) out.min = lo;
  if (hi !== undefined) out.max = hi;
  return out;
}

function mergeString(a: StringShape, b: StringShape, max: number): StringShape {
  const out: StringShape = { kind: 'string', count: a.count + b.count, formats: unionSorted(a.formats, b.formats) };
  if (a.values && b.values) {
    const values = unionSorted(a.values, b.values);
    if (values.length <= max) out.values = values;
  }
  const lo = minOf(a.minLength, b.minLength);
  const hi = maxOf(a.maxLength, b.maxLength);
  if (lo !== undefined) out.minLength = lo;
  if (hi !== undefined) out.maxLength = hi;
  return out;
}

function mergeArray(a: ArrayShape, b: ArrayShape, max: number): ArrayShape {
  const out: ArrayShape = {
    kind: 'array',
    count: a.count + b.count,
    minItems: Math.min(a.minItems, b.minItems),
    maxItems: Math.max(a.maxItems, b.maxItems),
  };
  const items = a.items && b.items ? mergeShapes(a.items, b.items, max) : (a.items ?? b.items);
  if (items) out.items = items;
  return out;
}

function mergeObject(a: ObjectShape, b: ObjectShape, max: number): ObjectShape {
  const properties = createMap<Shape>();
  for (const k of unionSorted(sortedKeys(a.properties), sortedKeys(b.properties))) {
    const x = own(a.properties, k);
    const y = own(b.properties, k);
    properties[k] = x && y ? mergeShapes(x, y, max) : (x ?? y)!;
  }
  const out: ObjectShape = { kind: 'object', count: a.count + b.count, properties };
  const additional = a.additional && b.additional ? mergeShapes(a.additional, b.additional, max) : (a.additional ?? b.additional);
  if (additional) out.additional = additional;
  if (a.truncated || b.truncated) out.truncated = true;
  return out;
}
