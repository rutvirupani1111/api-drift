import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBaseline, learn, learnEntry, parseBaseline } from '../src/core/baseline';
import { infer } from '../src/core/infer';
import { fileStore } from '../src/node/file-store';
import { jsonlReporter } from '../src/node/jsonl';
import { localStorageStore, loadBaselineInto, memoryStore, storeToBaseline, type StorageLike } from '../src/runtime/stores';
import { tempDir } from './helpers';

const entry = (v: unknown) => learnEntry(undefined, infer(v), { at: '2026-10-23T00:00:00Z' });

function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('memoryStore', () => {
  it('gets, sets, lists and deletes', async () => {
    const s = memoryStore();
    await s.set('a', entry(1));
    expect(await s.get('a')).toMatchObject({ samples: 1 });
    expect(await s.list()).toEqual(['a']);
    await s.delete?.('a');
    expect(await s.get('a')).toBeUndefined();
  });

  it('can be seeded from a baseline and exported back', () => {
    const b = learn(createBaseline(), 'k', { x: 1 });
    const s = memoryStore(b);
    expect(s.get('k')).toBe(b.endpoints.k);
    expect(Object.keys(s.toBaseline().endpoints)).toEqual(['k']);
  });
});

describe('localStorageStore', () => {
  it('stores one item per endpoint under a prefix', async () => {
    const storage = fakeStorage();
    storage.setItem('unrelated', 'x');
    const s = localStorageStore('drift:', { storage });
    await s.set('GET a /x 2xx', entry({ a: 1 }));
    expect(storage.data.has('drift:GET a /x 2xx')).toBe(true);
    expect(await s.list()).toEqual(['GET a /x 2xx']);
    expect(await s.get('GET a /x 2xx')).toMatchObject({ samples: 1, shape: { kind: 'object' } });
    await s.delete?.('GET a /x 2xx');
    expect(await s.list()).toEqual([]);
  });

  it('ignores corrupt items instead of throwing', async () => {
    const storage = fakeStorage();
    storage.setItem('api-drift:bad', '{not json');
    storage.setItem('api-drift:worse', '{"shape":{"kind":"nope"}}');
    const s = localStorageStore(undefined, { storage });
    expect(await s.get('bad')).toBeUndefined();
    expect(await s.get('worse')).toBeUndefined();
    expect(await s.get('missing')).toBeUndefined();
  });

  it('explains when no storage exists', () => {
    expect(() => localStorageStore()).toThrow('localStorage is not available');
  });
});

describe('store helpers', () => {
  it('storeToBaseline and loadBaselineInto round-trip', async () => {
    const b = learn(learn(createBaseline(), 'b', 1), 'a', 2);
    const s = memoryStore();
    await loadBaselineInto(s, b);
    const out = await storeToBaseline(s);
    expect(Object.keys(out.endpoints)).toEqual(['a', 'b']);
  });
});

describe('fileStore', () => {
  const dir = () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    return t.dir;
  };

  it('writes the baseline format atomically into new directories', async () => {
    const file = join(dir(), 'nested', 'deeper', 'baseline.json');
    const s = fileStore(file, { debounce: 5 });
    await s.set('GET a /x 2xx', entry({ a: 1 }));
    await s.set('GET a /y 2xx', entry([1]));
    await s.flush();
    const parsed = parseBaseline(readFileSync(file, 'utf8'));
    expect(Object.keys(parsed.endpoints)).toEqual(['GET a /x 2xx', 'GET a /y 2xx']);
    expect(readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('debounces writes', async () => {
    const file = join(dir(), 'b.json');
    const s = fileStore(file, { debounce: 40 });
    await s.set('k', entry(1));
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(existsSync(file)).toBe(true);
  });

  it('reads what a previous process wrote, and deletes', async () => {
    const file = join(dir(), 'b.json');
    const first = fileStore(file, { debounce: 1 });
    await first.set('k', entry({ a: 1 }));
    await first.flush();
    const second = fileStore(file);
    expect(await second.list()).toEqual(['k']);
    expect((await second.get('k'))?.samples).toBe(1);
    await second.delete?.('k');
    await second.flush();
    expect(Object.keys(parseBaseline(readFileSync(file, 'utf8')).endpoints)).toEqual([]);
  });

  it('refuses to overwrite a corrupt baseline', async () => {
    const file = join(dir(), 'b.json');
    writeFileSync(file, '{"version": 9}');
    const s = fileStore(file);
    await expect(s.get('k')).rejects.toThrow('Unsupported baseline version');
    expect(readFileSync(file, 'utf8')).toBe('{"version": 9}');
  });
});

describe('jsonlReporter', () => {
  it('appends one JSON line per event', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, 'logs', 'drift.jsonl');
    const report = jsonlReporter(file);
    const event = { key: 'k', severity: 'info' as const, changes: [], counts: { breaking: 0, risky: 0, info: 0 }, summary: 's', timestamp: 't' };
    await report(event);
    await report({ ...event, key: 'k2' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).key)).toEqual(['k', 'k2']);
  });
});
