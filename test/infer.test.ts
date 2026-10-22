import { describe, expect, it } from 'vitest';
import { infer, isPrivateKey, type InferWarning } from '../src/core/infer';
import type { ArrayShape, ObjectShape, StringShape } from '../src/core/shape';

const obj = (s: unknown) => s as ObjectShape;

describe('infer: primitives', () => {
  it('infers null, boolean, integer and number', () => {
    expect(infer(null)).toEqual({ kind: 'null', count: 1 });
    expect(infer(true)).toEqual({ kind: 'boolean', count: 1 });
    expect(infer(42)).toEqual({ kind: 'integer', count: 1 });
    expect(infer(4.2)).toEqual({ kind: 'number', count: 1, integral: 0 });
  });

  it('records sign, but not values, by default', () => {
    expect(infer(-3)).toEqual({ kind: 'integer', count: 1, negative: true });
    expect(infer(-0.5)).toEqual({ kind: 'number', count: 1, integral: 0, negative: true });
  });

  it('records ranges only when asked', () => {
    expect(infer(7, { ranges: true })).toEqual({ kind: 'integer', count: 1, min: 7, max: 7 });
    expect(infer('abc', { ranges: true })).toMatchObject({ minLength: 3, maxLength: 3 });
  });

  it('treats bigint as integer', () => {
    expect(infer(10n)).toEqual({ kind: 'integer', count: 1 });
  });

  it('detects string formats (or not, when disabled)', () => {
    expect(infer('2026-10-23T02:40:00Z')).toEqual({ kind: 'string', count: 1, formats: ['date-time'] });
    expect(infer('2026-10-23T02:40:00Z', { formats: false })).toMatchObject({ formats: ['plain'] });
    expect(infer('', { formats: false })).toMatchObject({ formats: ['empty'] });
  });
});

describe('infer: JSON semantics', () => {
  it('serialises Dates (toJSON) as date-time strings', () => {
    expect(infer(new Date('2026-10-23T00:00:00Z'))).toMatchObject({ kind: 'string', formats: ['date-time'] });
  });

  it('drops undefined and function properties, nulls them in arrays', () => {
    const s = obj(infer({ a: 1, b: undefined, c: () => 1 }));
    expect(Object.keys(s.properties)).toEqual(['a']);
    const arr = infer([undefined]) as ArrayShape;
    expect(arr.items).toEqual({ kind: 'null', count: 1 });
  });

  it('sorts object keys and never pollutes prototypes', () => {
    const s = obj(infer(JSON.parse('{"zeta":1,"__proto__":{"polluted":true},"alpha":2}')));
    expect(Object.keys(s.properties)).toEqual(['__proto__', 'alpha', 'zeta']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('is deterministic', () => {
    const v = { a: [1, 'x', null], b: { c: '2026-10-23' } };
    expect(infer(v)).toEqual(infer(v));
  });
});

describe('infer: arrays', () => {
  it('records length bounds and leaves empty arrays without items', () => {
    expect(infer([])).toEqual({ kind: 'array', count: 1, minItems: 0, maxItems: 0 });
    expect(infer([1, 2, 3])).toEqual({ kind: 'array', count: 1, minItems: 3, maxItems: 3, items: { kind: 'integer', count: 3 } });
  });

  it('merges heterogeneous items into a union', () => {
    const s = infer([1, 'a', null]) as ArrayShape;
    expect(s.items).toEqual({
      kind: 'union',
      variants: [
        { kind: 'null', count: 1 },
        { kind: 'integer', count: 1 },
        { kind: 'string', count: 1, formats: ['plain'], values: ['a'] },
      ],
    });
  });

  it('samples at most maxArrayItems items, always including the first and last', () => {
    const arr = Array.from({ length: 1000 }, (_, i) => (i === 999 ? { id: i, last: true } : { id: i }));
    const s = infer(arr) as ArrayShape;
    expect(s.maxItems).toBe(1000);
    const items = s.items as ObjectShape;
    expect(items.count).toBe(50);
    expect(items.properties.last).toEqual({ kind: 'boolean', count: 1 });
  });
});

describe('infer: enums and privacy', () => {
  const values = (s: unknown) => (s as StringShape).values;

  it('captures code-like values as enum candidates', () => {
    expect(values(obj(infer({ status: 'active' })).properties.status)).toEqual(['active']);
  });

  it('never captures free text, formatted strings or personal keys', () => {
    const s = obj(
      infer({
        note: 'two words',
        contact: 'rutvi@example.com',
        name: 'Rutvi',
        user_id: 'abc',
        firstName: 'Rutvi',
        apiToken: 'xyz',
      }),
    );
    for (const k of Object.keys(s.properties)) expect(values(s.properties[k])).toBeUndefined();
  });

  it('can be disabled entirely or re-targeted', () => {
    expect(values(obj(infer({ status: 'active' }, { enums: false })).properties.status)).toBeUndefined();
    expect(values(obj(infer({ name: 'Rutvi' }, { enumExclude: false })).properties.name)).toEqual(['Rutvi']);
    expect(values(obj(infer({ status: 'x' }, { enumExclude: /^status$/ })).properties.status)).toBeUndefined();
    expect(values(obj(infer({ tier: 'x' }, { enumExclude: (k) => k === 'tier' })).properties.tier)).toBeUndefined();
  });

  it('isPrivateKey splits snake, kebab and camel case', () => {
    expect(isPrivateKey('user_email')).toBe(true);
    expect(isPrivateKey('billingAddress')).toBe(true);
    expect(isPrivateKey('node-id')).toBe(true);
    expect(isPrivateKey('status')).toBe(false);
    expect(isPrivateKey('currency_code')).toBe(false);
    expect(isPrivateKey('')).toBe(false);
  });
});

describe('infer: id-keyed dictionaries', () => {
  it('collapses id-like keys into one additional shape', () => {
    const s = obj(obj(infer({ versions: { '1.0.0': { ok: true }, '2.0.0': { ok: false, extra: 1 } } })).properties.versions);
    expect(s.properties).toEqual({});
    expect(s.additional).toMatchObject({ kind: 'object', count: 2 });
    expect((s.additional as ObjectShape).properties.extra).toEqual({ kind: 'integer', count: 1 });
  });

  it('keeps keys as properties when dynamicKeys is off', () => {
    const s = obj(infer({ '123': 1 }, { dynamicKeys: false }));
    expect(Object.keys(s.properties)).toEqual(['123']);
  });
});

describe('infer: size guards', () => {
  it('stops at maxDepth with a single warning', () => {
    let v: unknown = 'leaf';
    for (let i = 0; i < 30; i++) v = { child: v };
    const warnings: InferWarning[] = [];
    const s = infer(v, { onWarning: (w) => warnings.push(w) });
    let node = s;
    let depth = 0;
    while (node.kind === 'object') {
      node = (node as ObjectShape).properties.child;
      depth++;
    }
    expect(node.kind).toBe('unknown');
    expect(depth).toBe(20);
    expect(warnings.map((w) => w.code)).toEqual(['max-depth']);
  });

  it('records at most maxProperties named keys', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 600; i++) big[`field_${i.toString(36)}x`] = i;
    const warnings: InferWarning[] = [];
    const s = obj(infer(big, { onWarning: (w) => warnings.push(w) }));
    expect(Object.keys(s.properties)).toHaveLength(500);
    expect(s.truncated).toBe(true);
    expect(warnings[0]?.code).toBe('max-properties');
  });

  it('gives up on payloads larger than maxPayloadBytes', () => {
    const warnings: InferWarning[] = [];
    const s = infer({ blob: 'x'.repeat(2_000_000) }, { onWarning: (w) => warnings.push(w) });
    expect(s).toEqual({ kind: 'unknown', count: 1 });
    expect(warnings[0]?.code).toBe('payload-too-large');
    expect(infer({ blob: 'x'.repeat(2_000) }, { maxPayloadBytes: 1_000 }).kind).toBe('unknown');
  });
});
