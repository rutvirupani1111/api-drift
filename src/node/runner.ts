import { relative, resolve } from 'node:path';
import { createBaseline, learnEntry, type Baseline } from '../core/baseline';
import { diff, makeChange } from '../core/diff';
import { endpointKey, parseEndpointKey, routeOf } from '../core/endpoint';
import { infer } from '../core/infer';
import { merge } from '../core/merge';
import { buildReport, type DriftReport, type EndpointResult, type FailOn } from '../core/report';
import { variantsOf, type Shape } from '../core/shape';
import { own, sortedKeys } from '../core/util';
import { readBaseline, writeBaseline } from './baseline-io';
import { ConfigError, libraryOptions, loadConfig, maskSecrets, resolveEndpoints, type LoadedConfig, type ResolvedEndpoint } from './config';
import { callEndpoint, mapLimit, type FetchLike } from './http';

export interface RunOptions {
  /** Working directory for relative paths. Default `process.cwd()`. */
  cwd?: string;
  /** Config file. Default `api-drift.config.json`. */
  config?: string;
  /** Baseline file; overrides the config. */
  baseline?: string;
  /** Override samples per endpoint. */
  samples?: number;
  /** Only endpoints whose name, URL or key contains one of these strings. */
  only?: string[];
  /** Environment for `${VAR}` substitution. Default `process.env`. */
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  /** Network retries per call. Default 1. */
  retries?: number;
}

interface Observation {
  ep: ResolvedEndpoint;
  key: string;
  shape?: Shape;
  httpStatus?: number;
  durationMs: number;
  error?: string;
}

interface Context {
  loaded: LoadedConfig;
  cwd: string;
  baselinePath: string;
  secrets: Set<string>;
  endpoints: ResolvedEndpoint[];
}

async function prepare(options: RunOptions): Promise<Context> {
  const cwd = options.cwd ?? process.cwd();
  const loaded = await loadConfig(options.config, cwd);
  const secrets = new Set<string>();
  const endpoints = resolveEndpoints(loaded.config, options.env ?? process.env, secrets, options.only);
  if (endpoints.length === 0) {
    throw new ConfigError(options.only?.length ? `No endpoint matches --only ${options.only.join(', ')}` : 'The config has no endpoints');
  }
  const baselinePath = options.baseline ? resolve(cwd, options.baseline) : loaded.baselinePath;
  return { loaded, cwd, baselinePath, secrets, endpoints };
}

async function observeAll(ctx: Context, options: RunOptions): Promise<Observation[]> {
  const { config } = ctx.loaded;
  const lib = libraryOptions(config);
  const maxPayloadBytes = lib.infer.maxPayloadBytes ?? 1_000_000;
  const mask = (s: string) => maskSecrets(s, ctx.secrets);
  return mapLimit(ctx.endpoints, config.concurrency ?? 4, async (ep) => {
    const n = options.samples ?? ep.samples;
    const fallbackKey = ep.key ?? mask(endpointKey({ method: ep.method, url: ep.url }, { keepQuery: ep.keepQuery }));
    const obs: Observation = { ep, key: fallbackKey, durationMs: 0 };
    let calls = 0;
    for (let i = 0; i < n; i++) {
      const r = await callEndpoint(ep, { fetch: options.fetch, maxPayloadBytes, retries: options.retries });
      calls++;
      obs.durationMs += r.durationMs;
      if (r.status !== undefined) obs.httpStatus = r.status;
      const key = r.status === undefined ? fallbackKey : (ep.key ?? mask(endpointKey({ method: ep.method, url: ep.url, status: r.status }, { keepQuery: ep.keepQuery })));
      if (!r.ok) {
        obs.key = key;
        obs.error = mask(r.error ?? 'request failed');
        obs.shape = undefined;
        break;
      }
      if (i > 0 && key !== obs.key) {
        obs.error = `samples disagree on the status class (${obs.key} then ${key})`;
        obs.shape = undefined;
        break;
      }
      obs.key = key;
      const shape = infer(r.value, lib.infer);
      if (shape.kind === 'unknown') {
        obs.error = 'response too large to inspect (raise maxPayloadBytes)';
        obs.shape = undefined;
        break;
      }
      obs.shape = obs.shape ? merge(obs.shape, shape, lib.infer) : shape;
    }
    obs.durationMs = Math.round(obs.durationMs / Math.max(1, calls));
    return obs;
  });
}

/** Count named fields in a shape (all depths), for summaries. */
export function countFields(shape: Shape): number {
  let n = 0;
  for (const v of variantsOf(shape)) {
    if (v.kind === 'object') {
      for (const k of Object.keys(v.properties)) n += 1 + countFields(v.properties[k]);
      if (v.additional) n += countFields(v.additional);
    } else if (v.kind === 'array' && v.items) n += countFields(v.items);
  }
  return n;
}

export interface SnapshotEndpoint {
  name?: string;
  method: string;
  url: string;
  key: string;
  status: 'ok' | 'error';
  httpStatus?: number;
  durationMs: number;
  fields?: number;
  error?: string;
  /** The previous baseline entry was kept because this endpoint failed. */
  kept?: boolean;
}

export interface SnapshotResult {
  baseline: Baseline;
  baselinePath: string;
  /** False when every endpoint failed (the old baseline is left untouched). */
  written: boolean;
  endpoints: SnapshotEndpoint[];
}

/**
 * Call every configured endpoint (`samples` times), infer and write the
 * baseline. With `merge`, extends the existing baseline instead of replacing it.
 */
export async function runSnapshot(options: RunOptions & { merge?: boolean } = {}): Promise<SnapshotResult> {
  const ctx = await prepare(options);
  const lib = libraryOptions(ctx.loaded.config);
  const observed = await observeAll(ctx, options);
  let previous: Baseline | undefined;
  try {
    previous = await readBaseline(ctx.baselinePath);
  } catch (e) {
    // A corrupt baseline cannot be merged into, but a fresh snapshot may replace it.
    if (options.merge) throw e;
  }
  const baseline: Baseline = options.merge && previous ? previous : createBaseline();
  const at = new Date().toISOString();
  const results: SnapshotEndpoint[] = [];
  for (const o of observed) {
    const base = { name: o.ep.name, method: o.ep.method, url: o.ep.displayUrl, key: o.key, httpStatus: o.httpStatus, durationMs: o.durationMs };
    if (!o.shape) {
      // Keep what we knew about a failing endpoint rather than silently dropping it.
      let kept = false;
      if (previous && !options.merge) {
        const route = routeOf(o.key);
        for (const k of sortedKeys(previous.endpoints)) {
          if (routeOf(k) === route && !own(baseline.endpoints, k)) {
            baseline.endpoints[k] = previous.endpoints[k];
            kept = true;
          }
        }
      }
      results.push({ ...base, status: 'error', error: o.error, kept });
      continue;
    }
    baseline.endpoints[o.key] = learnEntry(own(baseline.endpoints, o.key), o.shape, {
      at,
      example: o.ep.displayUrl,
      enumMaxValues: lib.infer.enumMaxValues,
    });
    results.push({ ...base, status: 'ok', fields: countFields(o.shape) });
  }
  baseline.updatedAt = at;
  const written = results.some((r) => r.status === 'ok');
  if (written) await writeBaseline(ctx.baselinePath, baseline);
  return { baseline, baselinePath: ctx.baselinePath, written, endpoints: results };
}

export interface CheckRunResult {
  report: DriftReport;
  baselinePath: string;
  /** True when `update` wrote the merged baseline. */
  updated: boolean;
}

/**
 * Call every configured endpoint again and diff against the baseline.
 * `report.failed` / `report.ok` follow `failOn` (option, then config, then `breaking`).
 */
export async function runCheck(options: RunOptions & { failOn?: FailOn; update?: boolean } = {}): Promise<CheckRunResult> {
  const ctx = await prepare(options);
  const baseline = await readBaseline(ctx.baselinePath);
  const shown = (relative(ctx.cwd, ctx.baselinePath) || ctx.baselinePath).replace(/\\/g, '/');
  if (!baseline) throw new ConfigError(`No baseline at ${shown}. Run \`api-drift snapshot\` first.`);
  const lib = libraryOptions(ctx.loaded.config);
  const observed = await observeAll(ctx, options);
  const keys = sortedKeys(baseline.endpoints);
  const results: EndpointResult[] = observed.map((o) => {
    const base = {
      key: o.key,
      name: o.ep.name,
      method: o.ep.method,
      url: o.ep.displayUrl,
      httpStatus: o.httpStatus,
      durationMs: o.durationMs,
    };
    if (!o.shape) return { ...base, status: 'error', changes: [], error: o.error };
    const entry = own(baseline.endpoints, o.key);
    if (entry) {
      const changes = diff(entry.shape, o.shape, lib.diff);
      return { ...base, status: changes.length ? 'drift' : 'ok', changes };
    }
    const route = routeOf(o.key);
    const other = keys.find((k) => routeOf(k) === route);
    if (other) {
      const from = parseEndpointKey(other)?.status ?? '?';
      const to = parseEndpointKey(o.key)?.status ?? '?';
      const change = makeChange('status-changed', '$', `status changed from ${from} to ${to}`, from, to, lib.diff);
      return { ...base, status: change ? 'drift' : 'ok', changes: change ? [change] : [] };
    }
    return { ...base, status: 'new', changes: [] };
  });
  const report = buildReport(results, {
    failOn: options.failOn ?? ctx.loaded.config.failOn ?? 'breaking',
    baseline: shown,
  });
  let updated = false;
  if (options.update) {
    const at = new Date().toISOString();
    for (const o of observed) {
      if (!o.shape) continue;
      baseline.endpoints[o.key] = learnEntry(own(baseline.endpoints, o.key), o.shape, {
        at,
        example: o.ep.displayUrl,
        enumMaxValues: lib.infer.enumMaxValues,
      });
      updated = true;
    }
    if (updated) {
      baseline.updatedAt = at;
      await writeBaseline(ctx.baselinePath, baseline);
    }
  }
  return { report, baselinePath: ctx.baselinePath, updated };
}
