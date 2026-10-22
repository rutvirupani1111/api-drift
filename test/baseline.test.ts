import { describe, expect, it } from 'vitest';
import {
  BaselineError,
  createBaseline,
  diffBaselines,
  learn,
  learnShape,
  mergeBaselines,
  normalizeShape,
  parseBaseline,
  serializeBaseline,
} from '../src/core/baseline';
import { infer } from '../src/core/infer';
import type { ObjectShape } from '../src/core/shape';

const KEY = 'GET api.test /users/:id 2xx';

describe('learn', () => {
  it('creates an entry and extends it with later samples', () => {
    let b = learn(createBaseline(), KEY, { id: 1, nickname: 'jj' }, { at: '2026-10-01T00:00:00Z', example: 'https://api.test/users/1?token=abc' });
    b = learn(b, KEY, { id: 2 }, { at: '2026-10-02T00:00:00Z' });
    const e = b.endpoints[KEY];
    expect(e.samples).toBe(2);
    expect(e.firstSeen).toBe('2026-10-01T00:00:00.000Z');
    expect(e.lastSeen).toBe('2026-10-02T00:00:00.000Z');
    expect(e.example).toBe('https://api.test/users/1');
    const props = (e.shape as ObjectShape).properties;
    expect(props.nickname).toMatchObject({ count: 1 });
    expect(b.updatedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('never mutates the input baseline', () => {
    const empty = createBaseline();
    const next = learnShape(empty, KEY, infer({ a: 1 }));
    expect(Object.keys(empty.endpoints)).toEqual([]);
    expect(Object.keys(next.endpoints)).toEqual([KEY]);
  });

  it('keeps first/last seen ordered even when samples arrive out of order', () => {
    let b = learn(createBaseline(), KEY, 1, { at: '2026-10-05T00:00:00Z' });
    b = learn(b, KEY, 2, { at: '2026-10-01T00:00:00Z' });
    expect(b.endpoints[KEY].firstSeen).toBe('2026-10-01T00:00:00.000Z');
    expect(b.endpoints[KEY].lastSeen).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('serialize / parse', () => {
  const sample = () => {
    let b = learn(createBaseline(), 'GET z.test /b 2xx', { b: [1, 'x'], __proto__: null }, { at: 0 });
    b = learn(b, 'GET a.test /a 2xx', JSON.parse('{"__proto__":{"x":1},"ok":true}'), { at: 0 });
    return b;
  };

  it('round-trips losslessly and deterministically', () => {
    const text = serializeBaseline(sample());
    expect(text.endsWith('\n')).toBe(true);
    const parsed = parseBaseline(text);
    expect(serializeBaseline(parsed)).toBe(text);
    expect(Object.keys(parsed.endpoints)).toEqual(['GET a.test /a 2xx', 'GET z.test /b 2xx']);
  });

  it('keeps a "__proto__" property as data', () => {
    const parsed = parseBaseline(serializeBaseline(sample()));
    const shape = parsed.endpoints['GET a.test /a 2xx'].shape as ObjectShape;
    expect(Object.keys(shape.properties)).toEqual(['__proto__', 'ok']);
    expect(shape.properties.__proto__).toMatchObject({ kind: 'object' });
  });

  it('writes entry metadata before the (large) shape', () => {
    const text = serializeBaseline(sample());
    expect(text.indexOf('"samples"')).toBeLessThan(text.indexOf('"shape"'));
  });

  it.each([
    ['not json', 'not valid JSON'],
    ['[]', 'must be a JSON object'],
    ['{"version":2,"endpoints":{}}', 'Unsupported baseline version'],
    ['{"version":1}', 'missing an "endpoints" object'],
    ['{"version":1,"endpoints":{"k":{"shape":{"kind":"wat"}}}}', 'Unknown shape kind "wat"'],
    ['{"version":1,"endpoints":{"k":{"shape":{"kind":"union","variants":[]}}}}', 'Union without variants'],
  ])('rejects %s', (input, message) => {
    expect(() => parseBaseline(input)).toThrow(BaselineError);
    expect(() => parseBaseline(input)).toThrow(message);
  });

  it('normalises hand-written shapes (merged union slots, sorted sets)', () => {
    const s = normalizeShape({
      kind: 'union',
      variants: [
        { kind: 'string', count: 1, formats: ['plain', 'date'], values: ['b', 'a', 'b'] },
        { kind: 'null' },
        { kind: 'string', count: 2, formats: ['date'] },
      ],
    });
    expect(s).toEqual({
      kind: 'union',
      variants: [
        { kind: 'null', count: 1 },
        { kind: 'string', count: 3, formats: ['date', 'plain'] },
      ],
    });
  });
});

describe('mergeBaselines / diffBaselines', () => {
  it('merges endpoint by endpoint', () => {
    const a = learn(createBaseline(), KEY, { a: 1 }, { at: '2026-10-01T00:00:00Z' });
    const b = learn(learn(createBaseline(), KEY, { b: 1 }, { at: '2026-10-03T00:00:00Z' }), 'GET other.test / 2xx', [], { at: 0 });
    const m = mergeBaselines(a, b);
    expect(Object.keys(m.endpoints)).toEqual([KEY, 'GET other.test / 2xx']);
    expect(m.endpoints[KEY].samples).toBe(2);
    expect(m.endpoints[KEY].firstSeen).toBe('2026-10-01T00:00:00.000Z');
    expect(m.endpoints[KEY].lastSeen).toBe('2026-10-03T00:00:00.000Z');
    expect(Object.keys((m.endpoints[KEY].shape as ObjectShape).properties)).toEqual(['a', 'b']);
  });

  it('reports drift, added and removed endpoints', () => {
    const a = learn(learn(createBaseline(), KEY, { a: 1 }), 'GET gone.test / 2xx', { x: 1 });
    const b = learn(learn(createBaseline(), KEY, { a: 'now a string' }), 'GET new.test / 2xx', { y: 1 });
    const d = diffBaselines(a, b);
    expect(d.map((x) => [x.key, x.status])).toEqual([
      ['GET api.test /users/:id 2xx', 'drift'],
      ['GET gone.test / 2xx', 'removed'],
      ['GET new.test / 2xx', 'added'],
    ]);
    expect(d[0].changes[0]).toMatchObject({ kind: 'type-changed', path: '$.a' });
    expect(d[1].changes[0]).toMatchObject({ kind: 'endpoint-removed', severity: 'info' });
  });

  it('detects a status class change on the same route', () => {
    const a = learn(createBaseline(), 'GET api.test /health 2xx', { ok: true });
    const b = learn(createBaseline(), 'GET api.test /health 5xx', { error: 'down' });
    const d = diffBaselines(a, b);
    expect(d).toHaveLength(1);
    expect(d[0].changes[0]).toMatchObject({ kind: 'status-changed', severity: 'breaking', before: '2xx', after: '5xx' });
    expect(d[0].changes[0].message).toBe('status changed from 2xx to 5xx');
  });

  it('identical baselines are ok', () => {
    const a = learn(createBaseline(), KEY, { a: 1 });
    expect(diffBaselines(a, a)).toEqual([{ key: KEY, status: 'ok', changes: [] }]);
  });
});
