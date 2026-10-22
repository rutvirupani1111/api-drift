import { describe, expect, it } from 'vitest';
import { changeFingerprint, countBySeverity, diff, maxSeverity, type Change, type DiffOptions } from '../src/core/diff';
import { infer } from '../src/core/infer';
import { mergeAll } from '../src/core/merge';

/** Learn a baseline from `before` samples, a current shape from `after` samples, and diff them. */
function drift(before: unknown[], after: unknown[], options?: DiffOptions): Change[] {
  return diff(mergeAll(before.map((v) => infer(v)))!, mergeAll(after.map((v) => infer(v)))!, options);
}
const times = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
const only = (changes: Change[]) => changes.map((c) => `${c.severity} ${c.kind} ${c.path}`);

describe('diff: no drift', () => {
  it('identical shapes produce nothing', () => {
    expect(drift([{ a: 1, b: 'x' }], [{ a: 2, b: 'y' }])).toEqual([]);
  });

  it('an optional field may be absent', () => {
    expect(drift([{ a: 1, b: 2 }, { a: 1 }], [{ a: 1 }])).toEqual([]);
  });

  it('a truncated (unknown) baseline is never compared', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 25; i++) deep = { x: deep };
    let deepString: unknown = 'now a string';
    for (let i = 0; i < 25; i++) deepString = { x: deepString };
    expect(drift([deep], [deepString])).toEqual([]);
  });
});

describe('diff: breaking', () => {
  it('a required field disappears', () => {
    const changes = drift([{ a: 1, b: 'x' }], [{ a: 1 }]);
    expect(only(changes)).toEqual(['breaking removed $.b']);
    expect(changes[0]).toMatchObject({ before: 'string', after: 'missing', message: 'field is missing (was present in the baseline sample)' });
  });

  it('says how many samples a removed field was in', () => {
    expect(drift([{ a: 1 }, { a: 2 }], [{}])[0].message).toBe('field is missing (was present in all 2 baseline samples)');
  });

  it('an incompatible type change', () => {
    const [c] = drift([{ price: '12.50' }], [{ price: 12 }]);
    expect(c).toMatchObject({ kind: 'type-changed', severity: 'breaking', path: '$.price' });
    expect(c.message).toBe('type changed from string<numeric-string> to integer');
  });

  it('an array became an object', () => {
    expect(drift([{ items: [1] }], [{ items: { a: 1 } }])[0].message).toBe('was an array, now an object');
  });

  it('an object became a primitive', () => {
    expect(drift([{ owner: { id: 1 } }], [{ owner: 'rutvi' }])[0].message).toBe('was an object, now a string');
  });

  it('reports "now also" when old and new types both appear', () => {
    const [c] = drift([{ v: 1 }], [{ v: 1 }, { v: true }]);
    expect(c.kind).toBe('type-changed');
    expect(c.message).toBe('now also boolean (was integer)');
  });

  it('describes union baselines in slot order', () => {
    expect(drift([{ v: 'a' }, { v: 1 }], [{ v: true }])[0].message).toBe('type changed from integer | string to boolean');
  });
});

describe('diff: risky', () => {
  it('a field became nullable', () => {
    const [c] = drift([{ homepage: 'https://x.dev' }], [{ homepage: null }]);
    expect(c).toMatchObject({ kind: 'nullable', severity: 'risky', before: 'string<uri>', after: 'null' });
    expect(c.message).toBe('can now be null (was string<uri>)');
  });

  it('a required field became optional', () => {
    const [c] = drift([{ a: 1, b: 1 }, { a: 1, b: 1 }], [{ a: 1, b: 1 }, { a: 1 }]);
    expect(c).toMatchObject({ kind: 'optional', severity: 'risky', path: '$.b', after: 'optional (1/2)' });
  });

  it('a new enum value appears once the enum is established', () => {
    const before = times(20, (i) => ({ status: i % 2 ? 'active' : 'paused' }));
    const [c] = drift(before, [{ status: 'archived' }]);
    expect(c).toMatchObject({ kind: 'enum-added', severity: 'risky', after: '"archived"' });
    expect(c.message).toBe('new enum value "archived" (known: "active", "paused")');
  });

  it('no enum is assumed before enumMinSamples observations', () => {
    expect(drift(times(5, () => ({ status: 'active' })), [{ status: 'archived' }])).toEqual([]);
    expect(only(drift(times(5, () => ({ status: 'active' })), [{ status: 'archived' }], { enumMinSamples: 5 }))).toEqual([
      'risky enum-added $.status',
    ]);
  });

  it('a non-code value is outside the enum', () => {
    const [c] = drift(times(20, () => ({ status: 'active' })), [{ status: 'In Progress' }]);
    expect(c.message).toBe('values outside the known enum (known: "active")');
  });

  it('a string format changed', () => {
    const [c] = drift([{ at: '2026-10-23T02:40:00Z' }], [{ at: 'yesterday' }]);
    expect(c).toMatchObject({ kind: 'format-changed', severity: 'risky', before: 'date-time', after: 'string' });
    expect(c.message).toBe('format changed from date-time to string');
  });

  it('a formatted field became empty', () => {
    expect(drift([{ at: '2026-10-23' }], [{ at: '' }])[0].message).toBe('can now be an empty string (was always date)');
  });

  it('number narrowed to integer after enough evidence', () => {
    const before = times(10, (i) => ({ price: i + 0.5 }));
    expect(only(drift(before, [{ price: 12 }]))).toEqual(['risky number-narrowed $.price']);
    expect(drift(before.slice(0, 3), [{ price: 12 }])).toEqual([]);
  });

  it('decimals appeared where only integers were seen', () => {
    const before = times(10, (i) => ({ qty: i }));
    expect(only(drift(before, [{ qty: 1.5 }]))).toEqual(['risky number-widened $.qty']);
    expect(drift(before.slice(0, 2), [{ qty: 1.5 }])).toEqual([]);
  });

  it('an array that always had items is now empty', () => {
    const [c] = drift([{ tags: ['a', 'b'] }, { tags: ['c'] }], [{ tags: [] }]);
    expect(c).toMatchObject({ kind: 'emptied', severity: 'risky', path: '$.tags' });
    expect(c.message).toBe('now empty (baseline always had at least 1 item)');
  });

  it('an array that was sometimes empty may be empty', () => {
    expect(drift([{ tags: ['a'] }, { tags: [] }], [{ tags: [] }])).toEqual([]);
  });
});

describe('diff: info', () => {
  it('a new field', () => {
    const [c] = drift([{ a: 1 }], [{ a: 1, b: 'x' }]);
    expect(c).toMatchObject({ kind: 'added', severity: 'info', path: '$.b', after: 'string', message: 'new field (string)' });
  });

  it('a new optional field', () => {
    const [c] = drift([{ a: 1 }], [{ a: 1, b: 1 }, { a: 1 }]);
    expect(c.kind).toBe('added-optional');
    expect(c.message).toBe('new optional field (integer, in 1 of 2 samples)');
  });

  it('an enum value disappeared (only reported with an established current enum)', () => {
    const before = times(20, (i) => ({ s: i % 2 ? 'a' : 'b' }));
    expect(only(drift(before, times(20, () => ({ s: 'a' }))))).toEqual(['info enum-removed $.s']);
    expect(drift(before, [{ s: 'a' }])).toEqual([]);
  });

  it('a format was gained', () => {
    const [c] = drift([{ v: 'hello' }], [{ v: '2026-10-23T00:00:00Z' }]);
    expect(c).toMatchObject({ kind: 'format-gained', severity: 'info', after: 'date-time' });
  });

  it('a null-only field got a type', () => {
    expect(drift([{ v: null }], [{ v: 'x' }])[0]).toMatchObject({ kind: 'type-learned', severity: 'info', message: 'now string (baseline only saw null)' });
  });

  it('an array got items for the first time', () => {
    expect(drift([{ v: [] }], [{ v: [1] }])[0]).toMatchObject({ kind: 'type-learned', path: '$.v' });
  });

  it('negative numbers appeared after enough evidence', () => {
    expect(only(drift(times(10, (i) => ({ n: i })), [{ n: -1 }]))).toEqual(['info negative $.n']);
  });
});

describe('diff: paths, options and ordering', () => {
  it('builds JSONPath-like paths through arrays, maps and odd keys', () => {
    const changes = drift(
      [{ data: { items: [{ price: 1 }] }, 'content-type': 'a', versions: { '1.0.0': { ok: true } } }],
      [{ data: { items: [{ price: 'x' }] }, 'content-type': 1, versions: { '2.0.0': { ok: 'yes' } } }],
    );
    expect(changes.map((c) => c.path).sort()).toEqual(['$.data.items[].price', '$.versions.*.ok', '$["content-type"]']);
  });

  it('ignores exact paths, their children, wildcards and RegExps', () => {
    const before = [{ meta: { a: 1, b: 1 }, items: [{ x: 1, y: 1 }], keep: 1 }];
    const after = [{ meta: {}, items: [{}], keep: 'changed' }];
    expect(only(drift(before, after, { ignore: ['$.meta', '$.items[].*'] }))).toEqual(['breaking type-changed $.keep']);
    expect(only(drift(before, after, { ignore: [/^\$\.(meta|items)/] }))).toEqual(['breaking type-changed $.keep']);
  });

  it('re-grades or silences change kinds', () => {
    expect(drift([{ a: 1 }], [{ a: 1, b: 1 }], { severity: { added: 'ignore' } })).toEqual([]);
    expect(drift([{ a: 1 }], [{ a: 1, b: 1 }], { severity: { added: 'breaking' } })[0].severity).toBe('breaking');
  });

  it('orders breaking, then risky, then info', () => {
    const changes = drift([{ a: 1, b: 'x', c: 'y' }], [{ b: null, c: 'y', d: 1 }]);
    expect(changes.map((c) => c.severity)).toEqual(['breaking', 'risky', 'info']);
  });

  it('fingerprints are stable and scoped', () => {
    const [c] = drift([{ a: 1 }], [{}]);
    expect(changeFingerprint(c)).toBe(changeFingerprint({ ...c }));
    expect(changeFingerprint(c, 'GET a /x 2xx')).not.toBe(changeFingerprint(c, 'GET b /x 2xx'));
    expect(changeFingerprint(c)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('counts and ranks severities', () => {
    const changes = drift([{ a: 1, b: 'x' }], [{ b: null, z: 1 }]);
    expect(countBySeverity(changes)).toEqual({ breaking: 1, risky: 1, info: 1 });
    expect(maxSeverity(changes)).toBe('breaking');
    expect(maxSeverity([])).toBeUndefined();
  });

  it('root type changes are reported at $', () => {
    expect(drift([[1]], [{ a: 1 }])[0]).toMatchObject({ path: '$', message: 'was an array, now an object' });
  });
});
