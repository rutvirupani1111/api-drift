import { createBaseline, isBaseline, normalizeEntry, type Baseline, type BaselineEntry } from '../core/baseline';
import { createMap, own } from '../core/util';
import type { DriftStore } from './types';

/** In-memory store. Optionally seeded from a baseline (e.g. one made by `api-drift snapshot`). */
export function memoryStore(initial?: Baseline | Record<string, BaselineEntry>): DriftStore & { toBaseline(): Baseline } {
  const map = new Map<string, BaselineEntry>();
  const seed = initial ? (isBaseline(initial) ? initial.endpoints : initial) : {};
  for (const k of Object.keys(seed)) map.set(k, seed[k]);
  return {
    get: (key) => map.get(key),
    set: (key, entry) => {
      map.set(key, entry);
    },
    list: () => [...map.keys()],
    delete: (key) => {
      map.delete(key);
    },
    toBaseline() {
      const b = createBaseline();
      for (const [k, v] of map) b.endpoints[k] = v;
      return b;
    },
  };
}

/** The subset of the Web Storage API the localStorage store uses. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Browser store backed by `localStorage` (or any Web Storage), one item per
 * endpoint under `prefix`. Corrupt items are ignored rather than thrown.
 */
export function localStorageStore(prefix = 'api-drift:', options: { storage?: StorageLike } = {}): DriftStore {
  const storage = options.storage ?? (globalThis as { localStorage?: StorageLike }).localStorage;
  if (!storage) throw new Error('api-drift: localStorage is not available here; pass { storage }');
  return {
    get(key) {
      const raw = storage.getItem(prefix + key);
      if (raw === null) return undefined;
      try {
        return normalizeEntry(JSON.parse(raw), key);
      } catch {
        return undefined;
      }
    },
    set(key, entry) {
      storage.setItem(prefix + key, JSON.stringify(entry));
    },
    list() {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k !== null && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
      }
      return keys;
    },
    delete(key) {
      storage.removeItem(prefix + key);
    },
  };
}

/** Read every entry of a store into a baseline. */
export async function storeToBaseline(store: DriftStore): Promise<Baseline> {
  const baseline = createBaseline();
  const endpoints = createMap<BaselineEntry>();
  for (const key of (await store.list()).sort()) {
    const entry = await store.get(key);
    if (entry) endpoints[key] = entry;
  }
  baseline.endpoints = endpoints;
  return baseline;
}

/** Copy a baseline's entries into a store (e.g. to seed it from a committed file). */
export async function loadBaselineInto(store: DriftStore, baseline: Baseline): Promise<void> {
  for (const key of Object.keys(baseline.endpoints)) {
    const entry = own(baseline.endpoints, key);
    if (entry) await store.set(key, entry);
  }
}
