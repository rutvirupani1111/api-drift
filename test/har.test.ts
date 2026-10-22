import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBaseline, learn } from '../src/core/baseline';
import { importHar } from '../src/core/har';
import type { ObjectShape } from '../src/core/shape';

const HAR = readFileSync(new URL('./fixtures/session.har', import.meta.url), 'utf8');
const USERS = 'GET api.shop.test /api/users/:id 2xx';

describe('importHar', () => {
  it('groups JSON responses by endpoint key and merges them', () => {
    const { baseline, stats, learnedKeys } = importHar(HAR);
    expect(learnedKeys).toEqual({
      'GET api.shop.test /api/orders 2xx': 2,
      'GET api.shop.test /api/users/:id 2xx': 3,
      'GET api.shop.test /api/users/:id 4xx': 1,
      'POST api.shop.test /api/cart 2xx': 1,
    });
    expect(stats).toEqual({
      entries: 12,
      learned: 7,
      skipped: 5,
      endpoints: 4,
      reasons: { 'not-json': 2, 'no-body': 1, 'invalid-json': 1, 'no-response': 1 },
    });
    expect(baseline.endpoints[USERS].samples).toBe(3);
  });

  it('decodes base64 bodies and learns optional and nullable fields', () => {
    const users = importHar(HAR).baseline.endpoints[USERS].shape as ObjectShape;
    expect(users.count).toBe(3);
    expect(users.properties.nickname).toMatchObject({ count: 1 });
    expect(users.properties.avatar_url.kind).toBe('union');
    expect(users.properties.email).toMatchObject({ formats: ['email'] });
  });

  it('records timestamps from the HAR and examples without query strings', () => {
    const e = importHar(HAR).baseline.endpoints[USERS];
    expect(e.firstSeen).toBe('2026-10-22T10:00:00.000Z');
    expect(e.lastSeen).toBe('2026-10-22T10:00:02.000Z');
    expect(e.example).toBe('https://api.shop.test/api/users/1');
  });

  it('honours include/exclude filters', () => {
    const { stats } = importHar(HAR, { include: ['api.shop.test'], exclude: [/\/cart$/] });
    expect(stats.learned).toBe(6);
    expect(stats.reasons.filtered).toBe(4);
  });

  it('keeps selected query parameters in keys', () => {
    const { learnedKeys } = importHar(HAR, { keepQuery: ['page'] });
    expect(learnedKeys['GET api.shop.test /api/orders?page=:id 2xx']).toBe(2);
  });

  it('accepts a custom keyFor (null skips)', () => {
    const { learnedKeys, stats } = importHar(HAR, { keyFor: (r) => (r.method === 'POST' ? null : `${r.status}`) });
    expect(learnedKeys).toEqual({ '200': 5, '404': 1 });
    expect(stats.reasons.filtered).toBe(1);
  });

  it('merges into an existing baseline', () => {
    const existing = learn(createBaseline(), 'GET elsewhere.test / 2xx', { ok: true });
    const { baseline } = importHar(JSON.parse(HAR), { baseline: existing });
    expect(Object.keys(baseline.endpoints)).toHaveLength(5);
  });

  it('skips responses over maxPayloadBytes', () => {
    const { stats } = importHar(HAR, { maxPayloadBytes: 60 });
    expect(stats.reasons['too-large']).toBeGreaterThan(0);
  });

  it('rejects files that are not HAR', () => {
    expect(() => importHar('{"hello":1}')).toThrow('Not a HAR file');
  });
});
