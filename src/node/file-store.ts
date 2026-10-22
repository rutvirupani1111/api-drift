import { resolve } from 'node:path';
import { createBaseline, serializeBaseline, type Baseline } from '../core/baseline';
import { own, sortedKeys } from '../core/util';
import type { DriftStore } from '../runtime/types';
import { readBaseline, writeFileAtomic, writeFileAtomicSync } from './baseline-io';

export interface FileStoreOptions {
  /** Coalesce writes for this many ms. Default 250. */
  debounce?: number;
}

export interface FileStore extends DriftStore {
  readonly path: string;
  /** Write pending changes now. */
  flush(): Promise<void>;
}

const live = new Set<() => void>();
let hooked = false;

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  // A last synchronous write for anything still pending when the process exits.
  process.once('exit', () => {
    for (const flushSync of live) {
      try {
        flushSync();
      } catch {
        // nothing sensible to do while exiting
      }
    }
  });
}

/**
 * A JSON file store (Node). Same format as `.api-drift/baseline.json`, so the
 * CLI and the runtime share baselines. Writes are debounced and atomic
 * (temp file + rename); a pending write is flushed on process exit.
 */
export function fileStore(path: string, options: FileStoreOptions = {}): FileStore {
  const file = resolve(path);
  const debounce = options.debounce ?? 250;
  let data: Baseline | undefined;
  let loading: Promise<Baseline> | undefined;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();

  const load = (): Promise<Baseline> => {
    if (data) return Promise.resolve(data);
    loading ??= readBaseline(file).then((b) => (data = b ?? createBaseline()));
    return loading;
  };

  const flushSync = () => {
    if (!dirty || !data) return;
    dirty = false;
    writeFileAtomicSync(file, serializeBaseline(data));
  };

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty || !data) return writing;
    dirty = false;
    const text = serializeBaseline(data);
    writing = writing.then(
      () => writeFileAtomic(file, text),
      () => writeFileAtomic(file, text),
    );
    return writing;
  };

  const schedule = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush().catch(() => undefined);
    }, debounce);
    (timer as { unref?: () => void }).unref?.();
  };

  live.add(flushSync);
  hookExit();

  return {
    path: file,
    async get(key) {
      return own((await load()).endpoints, key);
    },
    async set(key, entry) {
      const b = await load();
      b.endpoints[key] = entry;
      if (!b.updatedAt || entry.lastSeen > b.updatedAt) b.updatedAt = entry.lastSeen;
      schedule();
    },
    async list() {
      return sortedKeys((await load()).endpoints);
    },
    async delete(key) {
      const b = await load();
      delete b.endpoints[key];
      schedule();
    },
    flush,
  };
}
