import { describe, expect, it } from 'vitest';
import { parseBaseline, serializeBaseline, createBaseline, learnShape, normalizeShape } from '../src/core/baseline';
import { diff } from '../src/core/diff';
import { infer } from '../src/core/infer';
import { merge, mergeAll } from '../src/core/merge';
import type { ObjectShape, Shape, StringShape } from '../src/core/shape';
import { genValue, rng } from './helpers';

/** Remove every count-like field: what is left is the structural contract. */
function structure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structure);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'count' && k !== 'integral') out[k] = structure(v);
    return out;
  }
  return value;
}

/** Multiply every count-like field. */
function scale(value: unknown, by: number): unknown {
  if (Array.isArray(value)) return value.map((v) => scale(v, by));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'count' || k === 'integral' ? (v as number) * by : scale(v, by);
    return out;
  }
  return value;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

describe('merge: unit', () => {
  it('sums counts of identical kinds', () => {
    expect(merge(infer(1), infer(2))).toEqual({ kind: 'integer', count: 2 });
  });

  it('widens integer + number to number and counts whole numbers', () => {
    expect(merge(infer(1), infer(1.5))).toEqual({ kind: 'number', count: 2, integral: 1 });
    expect(merge(merge(infer(1), infer(1.5)), infer(2))).toEqual({ kind: 'number', count: 3, integral: 2 });
  });

  it('builds ordered unions and flattens nested unions', () => {
    const u = merge(infer('a'), infer(null));
    expect(u).toEqual({ kind: 'union', variants: [{ kind: 'null', count: 1 }, infer('a')] });
    const u2 = merge(u, merge(infer(true), infer('b')));
    expect(u2.kind).toBe('union');
    expect((u2 as { variants: Shape[] }).variants.map((v) => v.kind)).toEqual(['null', 'boolean', 'string']);
  });

  it('unions formats and enum values, dropping values past the cap for good', () => {
    const s = merge(infer('2026-10-23'), infer('')) as StringShape;
    expect(s.formats).toEqual(['date', 'empty']);
    let e: Shape = infer('a');
    for (const v of ['b', 'c']) e = merge(e, infer(v), { enumMaxValues: 3 });
    expect((e as StringShape).values).toEqual(['a', 'b', 'c']);
    e = merge(e, infer('d'), { enumMaxValues: 3 });
    expect((e as StringShape).values).toBeUndefined();
    e = merge(e, infer('a'), { enumMaxValues: 3 });
    expect((e as StringShape).values).toBeUndefined();
  });

  it('a non-code value removes enum candidacy', () => {
    expect((merge(infer('a'), infer('two words')) as StringShape).values).toBeUndefined();
  });

  it('merges array bounds and items', () => {
    expect(merge(infer([]), infer([1, 2]))).toEqual({ kind: 'array', count: 2, minItems: 0, maxItems: 2, items: { kind: 'integer', count: 2 } });
  });

  it('tracks property presence through counts', () => {
    const m = merge(infer({ a: 1, b: 2 }), infer({ a: 1 })) as ObjectShape;
    expect(m.count).toBe(2);
    expect(m.properties.a.kind === 'integer' && m.properties.a.count).toBe(2);
    expect(m.properties.b.kind === 'integer' && m.properties.b.count).toBe(1);
  });

  it('mergeAll folds a list (and returns undefined for none)', () => {
    expect(mergeAll([infer(1), infer(2), infer(3)])).toEqual({ kind: 'integer', count: 3 });
    expect(mergeAll([])).toBeUndefined();
  });

  it('never mutates its inputs', () => {
    const a = deepFreeze(infer({ a: [1, { b: 'x' }], c: null }));
    const b = deepFreeze(infer({ a: [2.5], d: '2026-10-23' }));
    expect(() => merge(a, b)).not.toThrow();
  });
});

describe('merge: algebraic properties (seeded random JSON)', () => {
  const RUNS = 250;
  const samples = (seed: number, n: number): Shape[] => {
    const next = rng(seed);
    return Array.from({ length: n }, () => infer(genValue(next)));
  };

  it('is commutative', () => {
    for (let i = 0; i < RUNS; i++) {
      const [a, b] = samples(i, 2);
      expect(merge(a, b)).toEqual(merge(b, a));
    }
  });

  it('is associative', () => {
    for (let i = 0; i < RUNS; i++) {
      const [a, b, c] = samples(1000 + i, 3);
      expect(merge(merge(a, b), c)).toEqual(merge(a, merge(b, c)));
    }
  });

  it('is idempotent on structure; counts double exactly', () => {
    for (let i = 0; i < RUNS; i++) {
      const [a] = samples(2000 + i, 1);
      const aa = merge(a, a);
      expect(structure(aa)).toEqual(structure(a));
      expect(aa).toEqual(scale(a, 2));
    }
  });

  it('is order independent over many samples', () => {
    for (let i = 0; i < 60; i++) {
      const xs = samples(3000 + i, 6);
      const next = rng(9000 + i);
      const shuffled = [...xs];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(next() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
      }
      expect(mergeAll(shuffled)).toEqual(mergeAll(xs));
    }
  });

  it('is sound: a learned sample never drifts against its own baseline', () => {
    for (let i = 0; i < RUNS; i++) {
      const [a, b] = samples(4000 + i, 2);
      expect(diff(a, a)).toEqual([]);
      const severe = diff(merge(a, b), a, { minSamples: 1, enumMinSamples: 1 }).filter((c) => c.severity !== 'info');
      expect(severe).toEqual([]);
    }
  });

  it('survives a baseline serialisation round trip unchanged', () => {
    for (let i = 0; i < 80; i++) {
      const merged = mergeAll(samples(5000 + i, 4))!;
      const b = learnShape(createBaseline(), 'k', merged, { at: 0 });
      const again = parseBaseline(serializeBaseline(b));
      expect(again.endpoints.k.shape).toEqual(normalizeShape(merged));
      expect(normalizeShape(merged)).toEqual(merged);
    }
  });
});
