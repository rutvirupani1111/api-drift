import type { BaselineEntry } from '../core/baseline';
import type { Change, SeverityCounts } from '../core/diff';
import type { Severity } from '../core/shape';

export type MaybePromise<T> = T | Promise<T>;

/**
 * Where learned contracts live. Implement `{ get, set, list }` for a custom
 * backend (Redis, KV, a database); every method may be sync or async.
 */
export interface DriftStore {
  get(key: string): MaybePromise<BaselineEntry | undefined>;
  set(key: string, entry: BaselineEntry): MaybePromise<void>;
  /** Every endpoint key in the store. */
  list(): MaybePromise<string[]>;
  delete?(key: string): MaybePromise<void>;
  /** Persist pending writes (file stores debounce them). */
  flush?(): Promise<void>;
}

/** A detected drift, after severity filtering and deduplication. */
export interface DriftEvent {
  /** Endpoint key: `GET api.example.com /users/:id 2xx`. */
  key: string;
  /** The most severe change in `changes`. */
  severity: Severity;
  changes: Change[];
  counts: SeverityCounts;
  /** One line, e.g. for `console.warn(e.summary)`. */
  summary: string;
  timestamp: string;
  /** The request that produced the drifting response (URL without query string). */
  request?: { method: string; url: string; status?: number };
}

export type Reporter = (event: DriftEvent) => void | Promise<void>;

export interface DriftWarning {
  code: 'too-large' | 'invalid-json' | 'max-depth' | 'max-properties' | 'payload-too-large';
  message: string;
  key?: string;
}
