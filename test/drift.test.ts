import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBaseline, learn } from '../src/core/baseline';
import { createDrift, type DriftOptions } from '../src/runtime/drift';
import { consoleReporter, unwrapFetch, webhookPayload, webhookReporter } from '../src/runtime/reporters';
import { memoryStore } from '../src/runtime/stores';
import type { DriftEvent, DriftWarning } from '../src/runtime/types';
import { mock } from './helpers';

const KEY = 'GET api.test /users/:id 2xx';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** A fetch that answers every call with `respond(url)`. */
function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return respond(url, init);
  };
}

function seeded(payload: unknown, key = KEY) {
  return memoryStore(learn(createBaseline(), key, payload, { at: 0 }));
}

function setup(options: DriftOptions) {
  const events: DriftEvent[] = [];
  const warnings: DriftWarning[] = [];
  const errors: unknown[] = [];
  const drift = createDrift({
    onDrift: (e) => {
      events.push(e);
    },
    onWarning: (w) => warnings.push(w),
    onError: (e) => errors.push(e),
    ...options,
  });
  return { drift, events, warnings, errors };
}

describe('wrapFetch', () => {
  it('returns the original Response, body unread', async () => {
    const res = json({ id: 1 });
    const { drift } = setup({ mode: 'learn' });
    const f = drift.wrapFetch(async (_url?: unknown, _init?: unknown) => res);
    const got = await f('https://api.test/users/1');
    expect(got).toBe(res);
    expect(await got.json()).toEqual({ id: 1 });
    await drift.flush();
    expect(await drift.store.list()).toEqual([KEY]);
  });

  it('propagates fetch failures untouched', async () => {
    const boom = new TypeError('network down');
    const { drift, errors } = setup({});
    const f = drift.wrapFetch(async (_url?: unknown, _init?: unknown) => {
      throw boom;
    });
    await expect(f('https://api.test/x')).rejects.toBe(boom);
    expect(errors).toEqual([]);
  });

  it('works with Request objects and init.method', async () => {
    const { drift } = setup({ mode: 'learn' });
    const f = drift.wrapFetch(fakeFetch(() => json({ ok: true }, { status: 201 })));
    await f(new Request('https://api.test/orders', { method: 'POST' }));
    await f('https://api.test/orders/9', { method: 'put' });
    await drift.flush();
    expect((await drift.store.list()).sort()).toEqual(['POST api.test /orders 2xx', 'PUT api.test /orders/:id 2xx']);
  });

  it('ignores non-JSON, HEAD and 204 responses', async () => {
    const { drift } = setup({ mode: 'learn' });
    await drift.wrapFetch(async (_url?: unknown, _init?: unknown) => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } }))('https://api.test/a');
    await drift.wrapFetch(async (_url?: unknown, _init?: unknown) => json({ a: 1 }))('https://api.test/b', { method: 'HEAD' });
    await drift.wrapFetch(async (_url?: unknown, _init?: unknown) => new Response(null, { status: 204, headers: { 'content-type': 'application/json' } }))('https://api.test/c');
    await drift.flush();
    expect(await drift.store.list()).toEqual([]);
  });

  it('skips bodies over maxPayloadBytes, by header or while streaming', async () => {
    const { drift, warnings } = setup({ mode: 'learn', maxPayloadBytes: 50 });
    await drift.wrapFetch(async (_url?: unknown, _init?: unknown) => json({ a: 1 }, { headers: { 'content-length': '5000' } }))('https://api.test/a');
    await drift.wrapFetch(async (_url?: unknown, _init?: unknown) => json({ blob: 'x'.repeat(500) }))('https://api.test/b');
    await drift.flush();
    expect(await drift.store.list()).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(['too-large', 'too-large']);
  });

  it('reports invalid JSON as a warning', async () => {
    const { drift, warnings } = setup({ mode: 'learn' });
    await drift.wrapFetch(async (_url?: unknown, _init?: unknown) => json('{not json'))('https://api.test/a');
    await drift.flush();
    expect(warnings[0]).toMatchObject({ code: 'invalid-json', key: 'GET api.test /a 2xx' });
  });

  it('swallows internal errors (store failures) and keeps serving responses', async () => {
    const broken = { get: () => Promise.reject(new Error('store down')), set: () => undefined, list: () => [] };
    const { drift, errors } = setup({ store: broken });
    const res = await drift.wrapFetch(async (_url?: unknown, _init?: unknown) => json({ a: 1 }))('https://api.test/a');
    expect(await res.json()).toEqual({ a: 1 });
    await drift.flush();
    expect(String(errors[0])).toContain('store down');
  });

  it('honours include, exclude, sampleRate and keyFor', async () => {
    const run = async (options: DriftOptions, url: string) => {
      const { drift } = setup({ mode: 'learn', ...options });
      await drift.wrapFetch(async (_url?: unknown, _init?: unknown) => json({ a: 1 }))(url);
      await drift.flush();
      return drift.store.list();
    };
    expect(await run({ include: ['api.test'] }, 'https://other.test/a')).toEqual([]);
    expect(await run({ exclude: [/\/internal\//] }, 'https://api.test/internal/a')).toEqual([]);
    expect(await run({ sampleRate: 0.5, random: () => 0.9 }, 'https://api.test/a')).toEqual([]);
    expect(await run({ sampleRate: 0.5, random: () => 0.1 }, 'https://api.test/a')).toEqual(['GET api.test /a 2xx']);
    expect(await run({ keyFor: (r) => `custom:${new URL(r.url).pathname}` }, 'https://api.test/a')).toEqual(['custom:/a']);
    expect(await run({ keyFor: () => null }, 'https://api.test/a')).toEqual([]);
  });

  it('patchGlobalFetch swaps globalThis.fetch and restores it', async () => {
    const original = globalThis.fetch;
    const fake = fakeFetch(() => json({ z: 1 })) as typeof fetch;
    globalThis.fetch = fake;
    try {
      const { drift } = setup({ mode: 'learn' });
      const undo = drift.patchGlobalFetch();
      expect(globalThis.fetch).not.toBe(fake);
      expect(unwrapFetch(globalThis.fetch)).toBe(fake);
      await fetch('https://api.test/patched');
      undo();
      expect(globalThis.fetch).toBe(fake);
      await drift.flush();
      expect(await drift.store.list()).toEqual(['GET api.test /patched 2xx']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('modes', () => {
  it('learn merges every sample', async () => {
    const { drift } = setup({ mode: 'learn' });
    for (let i = 0; i < 3; i++) await drift.check(KEY, { id: i, nick: i ? undefined : 'n' });
    const entry = await drift.store.get(KEY);
    expect(entry?.samples).toBe(3);
    expect(entry?.frozen).toBeUndefined();
  });

  it('watch reports drift against the frozen baseline', async () => {
    const { drift, events } = setup({ mode: 'watch', store: seeded({ id: 1, name: 'x' }) });
    const f = drift.wrapFetch(async (_url?: unknown, _init?: unknown) => json({ id: 2 }));
    await f('https://api.test/users/2?token=secret');
    await drift.flush();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({ key: KEY, severity: 'breaking', counts: { breaking: 1, risky: 0, info: 0 } });
    expect(e.request).toEqual({ method: 'GET', url: 'https://api.test/users/2', status: 200 });
    expect(e.summary).toBe(`api-drift: ${KEY} drifted (1 breaking): $.name field is missing (was present in the baseline sample)`);
    expect((await drift.store.get(KEY))?.samples).toBe(1);
  });

  it('watch skips endpoints without a baseline', async () => {
    const { drift } = setup({ mode: 'watch' });
    expect(await drift.check(KEY, { a: 1 })).toMatchObject({ action: 'skipped', reason: 'no-baseline' });
  });

  it('auto learns N samples, then freezes and reports', async () => {
    const { drift, events } = setup({ mode: 'auto', freezeAfter: { samples: 3 } });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await drift.check(KEY, { id: i, name: 'x' }));
    expect(results.map((r) => [r.action, r.frozen])).toEqual([
      ['learned', false],
      ['learned', false],
      ['learned', true],
    ]);
    const r = await drift.check(KEY, { id: 4 });
    expect(r.action).toBe('checked');
    expect(r.event?.changes[0]).toMatchObject({ kind: 'removed', path: '$.name' });
    expect(events).toHaveLength(1);
  });

  it('auto freezes after the learning window elapses', async () => {
    let t = Date.parse('2026-10-23T00:00:00Z');
    const { drift, events } = setup({ mode: 'auto', freezeAfter: { samples: 100, duration: '1m' }, now: () => t });
    await drift.check(KEY, { a: 1 });
    t += 61_000;
    const r = await drift.check(KEY, { a: 'changed' });
    expect(r.action).toBe('checked');
    expect((await drift.store.get(KEY))?.frozen).toBe(true);
    expect(events[0].changes[0].kind).toBe('type-changed');
  });

  it('serialises concurrent samples per endpoint', async () => {
    const { drift } = setup({ mode: 'learn' });
    await Promise.all(Array.from({ length: 25 }, (_, i) => drift.check(KEY, { id: i })));
    expect((await drift.store.get(KEY))?.samples).toBe(25);
  });

  it('parses string payloads and filters descriptors', async () => {
    const { drift } = setup({ mode: 'learn', include: ['api.test'] });
    expect(await drift.check(KEY, '{"a":1}')).toMatchObject({ action: 'learned' });
    expect(await drift.check(KEY, '{oops')).toMatchObject({ action: 'skipped', reason: 'invalid-json' });
    expect(await drift.check({ url: 'https://elsewhere.test/a', status: 200 }, {})).toMatchObject({ action: 'skipped', reason: 'filtered' });
    expect(await drift.check({ url: 'https://api.test/a/1', status: 200 }, {})).toMatchObject({ key: 'GET api.test /a/:id 2xx' });
  });

  it('exports the store as a baseline', async () => {
    const { drift } = setup({ mode: 'learn' });
    await drift.check('b-key', 1);
    await drift.check('a-key', 2);
    const b = await drift.baseline();
    expect(b.version).toBe(1);
    expect(Object.keys(b.endpoints)).toEqual(['a-key', 'b-key']);
  });
});

describe('dedup, cooldown and severity filter', () => {
  it('reports the same change once per cooldown', async () => {
    let t = 0;
    const { drift, events } = setup({ mode: 'watch', store: seeded({ a: 1 }), cooldown: '10m', now: () => t });
    await drift.check(KEY, {});
    await drift.check(KEY, {});
    expect(events).toHaveLength(1);
    t += 10 * 60_000;
    await drift.check(KEY, {});
    expect(events).toHaveLength(2);
  });

  it('a different change on the same endpoint is still reported', async () => {
    const { drift, events } = setup({ mode: 'watch', store: seeded({ a: 1, b: 1 }) });
    await drift.check(KEY, { b: 1 });
    await drift.check(KEY, { a: 1 });
    expect(events.map((e) => e.changes[0].path)).toEqual(['$.a', '$.b']);
  });

  it('cooldown 0 reports every time', async () => {
    const { drift, events } = setup({ mode: 'watch', store: seeded({ a: 1 }), cooldown: 0 });
    await drift.check(KEY, {});
    await drift.check(KEY, {});
    expect(events).toHaveLength(2);
  });

  it('minSeverity drops lower-severity events but keeps them in the result', async () => {
    const { drift, events } = setup({ mode: 'watch', store: seeded({ a: 'x' }), minSeverity: 'breaking' });
    const r = await drift.check(KEY, { a: null });
    expect(r.changes).toHaveLength(1);
    expect(r.event).toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe('reporters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('awaits async reporters on flush and routes reporter errors to onError', async () => {
    const seen: string[] = [];
    const { drift, errors } = setup({
      mode: 'watch',
      store: seeded({ a: 1 }),
      reporters: [
        async (e) => {
          await new Promise((r) => setTimeout(r, 20));
          seen.push(e.key);
        },
        () => {
          throw new Error('reporter broke');
        },
      ],
    });
    await drift.check(KEY, {});
    await drift.flush();
    expect(seen).toEqual([KEY]);
    expect(String(errors[0])).toContain('reporter broke');
  });

  it('consoleReporter prints a headline and aligned rows', () => {
    const lines: string[] = [];
    const report = consoleReporter({ color: false, log: (m) => lines.push(m) });
    const event: DriftEvent = {
      key: KEY,
      severity: 'breaking',
      changes: [{ path: '$.name', kind: 'removed', severity: 'breaking', message: 'field is missing' }],
      counts: { breaking: 1, risky: 0, info: 0 },
      summary: '',
      timestamp: '',
    };
    report(event);
    expect(lines[0]).toBe(`[api-drift] ✖ ${KEY} · 1 breaking\n  ✖ breaking  $.name  field is missing`);
    consoleReporter({ minSeverity: 'breaking', log: (m) => lines.push(m) })({ ...event, severity: 'info' });
    expect(lines).toHaveLength(1);
  });

  it('webhookReporter posts Slack, Discord or raw JSON payloads', async () => {
    const event: DriftEvent = {
      key: KEY,
      severity: 'risky',
      changes: [{ path: '$.a', kind: 'nullable', severity: 'risky', message: 'can now be null (was string)' }],
      counts: { breaking: 0, risky: 1, info: 0 },
      summary: 's',
      timestamp: 't',
    };
    expect(webhookPayload(event, 'slack')).toEqual({
      text: `*api-drift*: RISKY drift on \`${KEY}\`\n• RISKY \`$.a\` can now be null (was string)`,
    });
    expect((webhookPayload(event, 'discord') as { content: string }).content).toContain('**api-drift**');
    expect(webhookPayload(event, 'json')).toBe(event);

    const sent: Array<{ url: string; body: string }> = [];
    const fetch = async (url: string, init?: { body?: string }) => {
      sent.push({ url, body: init?.body ?? '' });
      return { ok: url.endsWith('/ok'), status: url.endsWith('/ok') ? 200 : 500 };
    };
    await webhookReporter('https://hooks.test/ok', { format: 'slack', fetch })(event);
    expect(JSON.parse(sent[0].body).text).toContain('RISKY');
    await expect(webhookReporter('https://hooks.test/fail', { fetch })(event)).rejects.toThrow('HTTP 500');
  });

  it('the default onError warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = { get: () => Promise.reject(new Error('x')), set: () => undefined, list: () => [] };
    const drift = createDrift({ store: broken });
    await drift.check(KEY, {}).catch(() => undefined);
    drift.observe({ url: 'https://api.test/a', status: 200, contentType: 'application/json', body: {} });
    drift.observe({ url: 'https://api.test/b', status: 200, contentType: 'application/json', body: {} });
    await drift.flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('observe (adapters)', () => {
  it('records JSON bodies and ignores the rest', async () => {
    const { drift } = setup({ mode: 'learn' });
    drift.observe({ method: 'get', url: 'https://api.test/a', status: 200, contentType: 'application/json', body: { a: 1 } });
    drift.observe({ url: 'https://api.test/b', status: 200, contentType: 'text/plain', body: 'hi' });
    drift.observe({ url: 'https://api.test/c', status: 200, contentType: 'application/json', body: '{"c":1}' });
    await drift.flush();
    expect((await drift.store.list()).sort()).toEqual(['GET api.test /a 2xx', 'GET api.test /c 2xx']);
  });
});

describe('against a real local server (port 5184)', () => {
  it('learns from live traffic and reports drift when the server changes', async () => {
    const url = await mock('/drift-int/users/7', { id: 7, plan: 'pro', email: 'x@y.co' });
    const learning = setup({ mode: 'learn' });
    const f1 = learning.drift.wrapFetch(globalThis.fetch);
    for (let i = 0; i < 3; i++) await (await f1(url)).json();
    await learning.drift.flush();
    const store = learning.drift.store;

    await mock('/drift-int/users/7', { id: '7', plan: 'pro', email: null });
    const watching = setup({ mode: 'watch', store });
    const res = await watching.drift.wrapFetch(globalThis.fetch)(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '7', plan: 'pro', email: null });
    await watching.drift.flush();
    expect(watching.events).toHaveLength(1);
    expect(watching.events[0].changes.map((c) => `${c.severity} ${c.path}`)).toEqual(['breaking $.id', 'risky $.email']);
  });
});
