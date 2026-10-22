import { learnEntry, type Baseline, type BaselineEntry } from '../core/baseline';
import { countBySeverity, diff, maxSeverity, severityRank, type Change, type DiffOptions } from '../core/diff';
import { endpointKey, redactUrl } from '../core/endpoint';
import { DEFAULT_LIMITS, infer, type InferOptions, type InferWarning } from '../core/infer';
import { compileMatchers, type Matcher } from '../core/match';
import type { Severity } from '../core/shape';
import { parseDuration } from '../core/util';
import { later, readTextCapped, type ResponseLike } from './body';
import { createDedup } from './dedup';
import { ORIGINAL_FETCH } from './reporters';
import { memoryStore, storeToBaseline } from './stores';
import type { DriftEvent, DriftStore, DriftWarning, Reporter } from './types';

/**
 * - `learn`: merge every sample into the baseline, never report.
 * - `watch`: the baseline is frozen; report drift against it.
 * - `auto`: learn each endpoint for N samples or T time, then freeze and watch.
 */
export type Mode = 'learn' | 'watch' | 'auto';

export interface RequestDescriptor {
  method?: string;
  url: string;
  status?: number;
}

export interface DriftOptions {
  /** Where contracts are kept. Default: `memoryStore()`. */
  store?: DriftStore;
  /** Default `auto`. */
  mode?: Mode;
  /** Only observe matching URLs: host strings, `host/path` prefixes, RegExps or predicates. */
  include?: Matcher | Matcher[];
  /** Never observe matching URLs. */
  exclude?: Matcher | Matcher[];
  /** Fraction of responses to inspect (0..1). Default 1. */
  sampleRate?: number;
  /** Custom endpoint key; return null/undefined to skip the request. */
  keyFor?: (request: RequestDescriptor) => string | null | undefined;
  /** Query parameters to keep in endpoint keys. */
  keepQuery?: string[];
  /** Shape inference options (enum capture, formats, limits). */
  infer?: Omit<InferOptions, 'onWarning'>;
  /** Diff options (ignore paths, severity overrides). */
  diff?: DiffOptions;
  /** Auto mode: freeze an endpoint after this many samples or this long. Default 20 samples / 1h. */
  freezeAfter?: { samples?: number; duration?: number | string };
  /** Drift below this severity is not reported. Default `info`. */
  minSeverity?: Severity;
  /** The same change on the same endpoint is reported at most once per cooldown. Default 1h. */
  cooldown?: number | string;
  /** Responses larger than this are skipped. Default 1 MB. */
  maxPayloadBytes?: number;
  reporters?: Reporter[];
  onDrift?: (event: DriftEvent) => void | Promise<void>;
  /** Internal failures (never thrown into your request path). Default: one console warning. */
  onError?: (error: unknown) => void;
  /** Skipped payloads and trimmed shapes. Default: ignored. */
  onWarning?: (warning: DriftWarning) => void;
  /** Clock and randomness, injectable for tests. */
  now?: () => number;
  random?: () => number;
}

export interface CheckResult {
  key: string;
  action: 'learned' | 'checked' | 'skipped';
  reason?: 'too-large' | 'invalid-json' | 'no-baseline' | 'filtered';
  /** True when the endpoint's baseline is frozen after this call. */
  frozen?: boolean;
  /** Every change against the baseline (before severity filtering and dedup). */
  changes: Change[];
  /** The event that was reported, if any. */
  event?: DriftEvent;
}

/** A response observed by an adapter (axios, custom clients). */
export interface ObservedResponse {
  method?: string;
  url: string;
  status: number;
  /** The content-type header; non-JSON responses are ignored. */
  contentType?: string | null;
  /** Parsed body, or the raw text. */
  body: unknown;
}

type FetchFn = (input: any, init?: any) => Promise<any>;

export interface Drift {
  readonly mode: Mode;
  readonly store: DriftStore;
  /** Wrap a fetch function. The returned Response is the original, untouched. */
  wrapFetch<F extends FetchFn>(fetchFn: F): F;
  /** Replace `globalThis.fetch` with a wrapped version. Returns an undo function. */
  patchGlobalFetch(): () => void;
  /** Check a payload manually (queues, websockets, SDK results). Not sampled. */
  check(key: string | RequestDescriptor, payload: unknown): Promise<CheckResult>;
  /** Fire-and-forget observation used by adapters; applies filters and sampling. */
  observe(response: ObservedResponse): void;
  /** Wait for in-flight inspections and reporters, then flush the store. */
  flush(): Promise<void>;
  /** Export everything the store knows as a baseline. */
  baseline(): Promise<Baseline>;
}

interface Target {
  key: string;
  request?: { method: string; url: string; status?: number };
}

const isJson = (contentType: string | null | undefined) => !!contentType && /json/i.test(contentType);

function summarize(key: string, changes: readonly Change[]): string {
  const c = countBySeverity(changes);
  const counts = [c.breaking && `${c.breaking} breaking`, c.risky && `${c.risky} risky`, c.info && `${c.info} info`].filter(Boolean).join(', ');
  const first = changes
    .slice(0, 3)
    .map((x) => `${x.path} ${x.message}`)
    .join('; ');
  return `api-drift: ${key} drifted (${counts}): ${first}${changes.length > 3 ? `; and ${changes.length - 3} more` : ''}`;
}

export function createDrift(options: DriftOptions = {}): Drift {
  const mode: Mode = options.mode ?? 'auto';
  const store = options.store ?? memoryStore();
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sampleRate = options.sampleRate ?? 1;
  const maxBytes = options.maxPayloadBytes ?? options.infer?.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes;
  const freezeSamples = options.freezeAfter?.samples ?? 20;
  const freezeMs = parseDuration(options.freezeAfter?.duration ?? '1h');
  const minRank = severityRank(options.minSeverity ?? 'info');
  const dedup = createDedup(parseDuration(options.cooldown ?? '1h'), now);
  const allowed = compileMatchers(options.include, options.exclude);
  const reporters = options.reporters ?? [];
  const pending = new Set<Promise<unknown>>();
  const locks = new Map<string, Promise<unknown>>();
  let complained = false;

  const onError =
    options.onError ??
    ((error: unknown) => {
      if (complained) return;
      complained = true;
      console.warn('[api-drift] internal error (further errors are silenced; pass onError to see them):', error);
    });
  const warn = (w: DriftWarning) => {
    try {
      options.onWarning?.(w);
    } catch (e) {
      onError(e);
    }
  };

  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    const done = () => pending.delete(p);
    p.then(done, done);
    return p;
  };

  function resolveTarget(desc: RequestDescriptor): Target | undefined {
    const method = (desc.method ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(desc.url, (globalThis as { location?: { href?: string } }).location?.href);
    } catch {
      return undefined;
    }
    if (!allowed(url, method)) return undefined;
    const request = { method, url: redactUrl(url), status: desc.status };
    const key = options.keyFor
      ? options.keyFor({ method, url: url.href, status: desc.status })
      : endpointKey({ method, url, status: desc.status }, { keepQuery: options.keepQuery });
    return key ? { key, request } : undefined;
  }

  function isLearning(entry: BaselineEntry | undefined, t: number): boolean {
    if (mode === 'learn') return true;
    if (mode === 'watch') return false;
    if (!entry) return true;
    if (entry.frozen) return false;
    const since = Date.parse(entry.firstSeen);
    return entry.samples < freezeSamples && !(t - since >= freezeMs);
  }

  function dispatch(event: DriftEvent): void {
    for (const fn of [options.onDrift, ...reporters]) {
      if (!fn) continue;
      try {
        const r = fn(event);
        if (r && typeof (r as Promise<void>).then === 'function') track((r as Promise<void>).catch(onError));
      } catch (e) {
        onError(e);
      }
    }
  }

  async function processUnlocked(target: Target, payload: unknown): Promise<CheckResult> {
    const { key, request } = target;
    let value = payload;
    if (typeof payload === 'string') {
      if (payload.length > maxBytes) {
        warn({ code: 'too-large', key, message: `response larger than ${maxBytes} bytes skipped` });
        return { key, action: 'skipped', reason: 'too-large', changes: [] };
      }
      try {
        value = JSON.parse(payload);
      } catch {
        warn({ code: 'invalid-json', key, message: 'response is not valid JSON' });
        return { key, action: 'skipped', reason: 'invalid-json', changes: [] };
      }
    }
    const shape = infer(value, {
      ...options.infer,
      maxPayloadBytes: maxBytes,
      onWarning: (w: InferWarning) => warn({ code: w.code, key, message: `${w.path}: ${w.message}` }),
    });
    if (shape.kind === 'unknown') return { key, action: 'skipped', reason: 'too-large', changes: [] };
    const t = now();
    const entry = await store.get(key);
    if (isLearning(entry, t)) {
      const next = learnEntry(entry, shape, { at: t, example: request?.url, enumMaxValues: options.infer?.enumMaxValues });
      if (mode === 'auto' && next.samples >= freezeSamples) next.frozen = true;
      await store.set(key, next);
      return { key, action: 'learned', frozen: !!next.frozen, changes: [] };
    }
    if (!entry) return { key, action: 'skipped', reason: 'no-baseline', changes: [] };
    if (mode === 'auto' && !entry.frozen) await store.set(key, { ...entry, frozen: true });
    const changes = diff(entry.shape, shape, options.diff);
    const reportable = dedup.filter(
      key,
      changes.filter((c) => severityRank(c.severity) >= minRank),
    );
    const result: CheckResult = { key, action: 'checked', frozen: true, changes };
    if (reportable.length > 0) {
      const event: DriftEvent = {
        key,
        severity: maxSeverity(reportable)!,
        changes: reportable,
        counts: countBySeverity(reportable),
        summary: summarize(key, reportable),
        timestamp: new Date(t).toISOString(),
      };
      if (request) event.request = request;
      result.event = event;
      dispatch(event);
    }
    return result;
  }

  /** Serialise work per endpoint so concurrent responses never race on the store. */
  function process(target: Target, payload: unknown): Promise<CheckResult> {
    const prev = locks.get(target.key) ?? Promise.resolve();
    const run = prev.then(() => processUnlocked(target, payload));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(target.key, settled);
    settled.then(() => {
      if (locks.get(target.key) === settled) locks.delete(target.key);
    });
    return run;
  }

  function observe(response: ObservedResponse): void {
    try {
      if (!isJson(response.contentType)) return;
      if (sampleRate < 1 && random() >= sampleRate) return;
      const target = resolveTarget(response);
      if (!target) return;
      track(later(() => process(target, response.body)).catch(onError));
    } catch (e) {
      onError(e);
    }
  }

  function inspect(input: unknown, init: { method?: string } | undefined, res: ResponseLike): void {
    if (!res || typeof res.status !== 'number' || !res.headers) return;
    const req = input as { url?: string; method?: string } | string | URL;
    const method = (init?.method ?? (typeof req === 'object' && !(req instanceof URL) ? req.method : undefined) ?? 'GET').toUpperCase();
    if (method === 'HEAD' || res.status === 204 || res.status === 304 || res.status === 0) return;
    if (!isJson(res.headers.get('content-type'))) return;
    const length = Number(res.headers.get('content-length'));
    if (length > maxBytes) {
      warn({ code: 'too-large', message: `response larger than ${maxBytes} bytes skipped` });
      return;
    }
    if (sampleRate < 1 && random() >= sampleRate) return;
    const url = typeof req === 'string' ? req : req instanceof URL ? req.href : (req?.url ?? '');
    const target = resolveTarget({ method, url, status: res.status });
    if (!target) return;
    const copy = res.clone();
    track(
      readTextCapped(copy, maxBytes)
        .then((text) => {
          if (text === undefined) {
            warn({ code: 'too-large', key: target.key, message: `response larger than ${maxBytes} bytes skipped` });
            return undefined;
          }
          return later(() => process(target, text));
        })
        .catch(onError),
    );
  }

  function wrapFetch<F extends FetchFn>(fetchFn: F): F {
    const wrapped = function (this: unknown, input: unknown, init?: { method?: string }) {
      return fetchFn(input, init).then((res: ResponseLike) => {
        try {
          inspect(input, init, res);
        } catch (e) {
          onError(e);
        }
        return res;
      });
    };
    Object.defineProperty(wrapped, ORIGINAL_FETCH, { value: fetchFn });
    return wrapped as unknown as F;
  }

  return {
    mode,
    store,
    wrapFetch,
    patchGlobalFetch() {
      const g = globalThis as { fetch?: FetchFn };
      if (typeof g.fetch !== 'function') throw new Error('api-drift: globalThis.fetch is not available');
      const original = g.fetch;
      const wrapped = wrapFetch(original);
      g.fetch = wrapped;
      return () => {
        if (g.fetch === wrapped) g.fetch = original;
      };
    },
    check(key, payload) {
      const target = typeof key === 'string' ? { key } : resolveTarget(key);
      if (!target) {
        return Promise.resolve({ key: typeof key === 'string' ? key : key.url, action: 'skipped', reason: 'filtered', changes: [] });
      }
      return track(process(target, payload));
    },
    observe,
    async flush() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
      await store.flush?.();
    },
    baseline: () => storeToBaseline(store),
  };
}
