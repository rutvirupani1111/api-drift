import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { DEFAULT_SEVERITY, type ChangeKind, type DiffOptions } from '../core/diff';
import type { InferOptions } from '../core/infer';
import type { FailOn } from '../core/report';
import type { Severity } from '../core/shape';
import { parseJsonc } from './jsonc';

export const DEFAULT_CONFIG_FILE = 'api-drift.config.json';
export const DEFAULT_BASELINE_FILE = '.api-drift/baseline.json';

export interface EndpointConfig {
  /** Friendly name shown in reports. */
  name?: string;
  /** Override the endpoint key (default: derived from method, URL and status). */
  key?: string;
  /** Default GET. */
  method?: string;
  /** Absolute URL; `${ENV_VAR}` and `${ENV_VAR:-default}` are substituted. */
  url: string;
  headers?: Record<string, string>;
  /** JSON-serialised unless it is a string. */
  body?: unknown;
  /** Calls per run; more samples give better optional/required detection. Default 1. */
  samples?: number;
  /** Request timeout in ms. Default 10000. */
  timeout?: number;
  /** Query parameters to keep in the endpoint key. */
  keepQuery?: string[];
}

export interface DriftConfig {
  $schema?: string;
  /** Baseline file, relative to the config file. Default `.api-drift/baseline.json`. */
  baseline?: string;
  /** Applied to every endpoint unless overridden. */
  defaults?: Omit<EndpointConfig, 'url' | 'name' | 'key'>;
  endpoints: EndpointConfig[];
  /** Default `breaking`. */
  failOn?: FailOn;
  /** Endpoints called in parallel. Default 4. */
  concurrency?: number;
  /** Responses larger than this fail the endpoint. Default 1 MB. */
  maxPayloadBytes?: number;
  infer?: Omit<InferOptions, 'onWarning' | 'enumExclude'> & { enumExclude?: string | false };
  diff?: Omit<DiffOptions, 'ignore'> & { ignore?: string[] };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface LoadedConfig {
  config: DriftConfig;
  /** Absolute path of the config file. */
  path: string;
  /** Absolute path of the baseline file. */
  baselinePath: string;
}

const FAIL_ON = ['breaking', 'risky', 'info', 'never'];
const SEVERITIES = ['breaking', 'risky', 'info', 'ignore'];

/** Load, parse (JSONC) and validate a config file. */
export async function loadConfig(path = DEFAULT_CONFIG_FILE, cwd = process.cwd()): Promise<LoadedConfig> {
  const file = resolve(cwd, path);
  const shown = relative(cwd, file) || file;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`No config file at ${shown}. Run \`api-drift init\` to create one.`);
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (e) {
    throw new ConfigError(`${shown} is not valid JSON: ${(e as Error).message}`);
  }
  const config = validateConfig(raw, shown);
  return { config, path: file, baselinePath: resolve(dirname(file), config.baseline ?? DEFAULT_BASELINE_FILE) };
}

/** Validate a parsed config object. Throws ConfigError naming the bad field. */
export function validateConfig(raw: unknown, source = 'config'): DriftConfig {
  const fail = (msg: string): never => {
    throw new ConfigError(`${source}: ${msg}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must be a JSON object');
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.endpoints)) fail('"endpoints" must be an array');
  const isRecordOfStrings = (v: unknown) =>
    !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
  const checkEndpointish = (e: Record<string, unknown>, where: string) => {
    if (e.method !== undefined && (typeof e.method !== 'string' || !/^[A-Za-z]+$/.test(e.method))) fail(`${where}.method must be an HTTP method`);
    if (e.headers !== undefined && !isRecordOfStrings(e.headers)) fail(`${where}.headers must map header names to strings`);
    if (e.samples !== undefined && (!Number.isInteger(e.samples) || (e.samples as number) < 1 || (e.samples as number) > 100)) {
      fail(`${where}.samples must be an integer between 1 and 100`);
    }
    if (e.timeout !== undefined && (typeof e.timeout !== 'number' || e.timeout <= 0)) fail(`${where}.timeout must be a positive number (ms)`);
    if (e.keepQuery !== undefined && (!Array.isArray(e.keepQuery) || !e.keepQuery.every((x) => typeof x === 'string'))) {
      fail(`${where}.keepQuery must be an array of strings`);
    }
  };
  (c.endpoints as unknown[]).forEach((e, i) => {
    const where = `endpoints[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) fail(`${where} must be an object`);
    const ep = e as Record<string, unknown>;
    if (typeof ep.url !== 'string' || ep.url.trim() === '') fail(`${where}.url must be a non-empty string`);
    if (ep.name !== undefined && typeof ep.name !== 'string') fail(`${where}.name must be a string`);
    if (ep.key !== undefined && typeof ep.key !== 'string') fail(`${where}.key must be a string`);
    checkEndpointish(ep, where);
  });
  if (c.defaults !== undefined) {
    if (!c.defaults || typeof c.defaults !== 'object' || Array.isArray(c.defaults)) fail('"defaults" must be an object');
    checkEndpointish(c.defaults as Record<string, unknown>, 'defaults');
  }
  if (c.baseline !== undefined && typeof c.baseline !== 'string') fail('"baseline" must be a file path');
  if (c.failOn !== undefined && !FAIL_ON.includes(c.failOn as string)) fail(`"failOn" must be one of ${FAIL_ON.join(', ')}`);
  if (c.concurrency !== undefined && (!Number.isInteger(c.concurrency) || (c.concurrency as number) < 1)) fail('"concurrency" must be a positive integer');
  if (c.maxPayloadBytes !== undefined && (typeof c.maxPayloadBytes !== 'number' || c.maxPayloadBytes <= 0)) fail('"maxPayloadBytes" must be a positive number');
  if (c.diff !== undefined) {
    const d = c.diff as Record<string, unknown>;
    if (!d || typeof d !== 'object') fail('"diff" must be an object');
    if (d.ignore !== undefined && (!Array.isArray(d.ignore) || !d.ignore.every((x) => typeof x === 'string'))) fail('"diff.ignore" must be an array of paths');
    if (d.severity !== undefined) {
      if (!d.severity || typeof d.severity !== 'object') fail('"diff.severity" must be an object');
      for (const [kind, sev] of Object.entries(d.severity as Record<string, unknown>)) {
        if (!(kind in DEFAULT_SEVERITY)) fail(`"diff.severity" has unknown change kind "${kind}" (known: ${Object.keys(DEFAULT_SEVERITY).join(', ')})`);
        if (!SEVERITIES.includes(sev as string)) fail(`"diff.severity.${kind}" must be one of ${SEVERITIES.join(', ')}`);
      }
    }
  }
  if (c.infer !== undefined && (!c.infer || typeof c.infer !== 'object')) fail('"infer" must be an object');
  return c as unknown as DriftConfig;
}

/** Convert config-file diff/infer options into library options. */
export function libraryOptions(config: DriftConfig): { infer: InferOptions; diff: DiffOptions } {
  const { enumExclude, ...infer } = config.infer ?? {};
  const inferOptions: InferOptions = { ...infer, maxPayloadBytes: config.maxPayloadBytes ?? infer.maxPayloadBytes };
  if (enumExclude === false) inferOptions.enumExclude = false;
  else if (typeof enumExclude === 'string') inferOptions.enumExclude = new RegExp(enumExclude, 'i');
  const diff: DiffOptions = {
    ...config.diff,
    severity: config.diff?.severity as Partial<Record<ChangeKind, Severity | 'ignore'>> | undefined,
  };
  return { infer: inferOptions, diff };
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Substitute `${VAR}` / `${VAR:-default}` from `env`. Values taken from the
 * environment (6+ chars) are added to `secrets` so reports can mask them.
 */
export function substituteEnv(
  value: string,
  env: Record<string, string | undefined>,
  secrets: Set<string>,
  where: string,
): string {
  return value.replace(VAR, (_m, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== '') {
      if (v.length >= 6) secrets.add(v);
      return v;
    }
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`Environment variable ${name} is not set (used in ${where}). Set it, or write \${${name}:-default}.`);
  });
}

function substituteDeep(value: unknown, env: Record<string, string | undefined>, secrets: Set<string>, where: string): unknown {
  if (typeof value === 'string') return substituteEnv(value, env, secrets, where);
  if (Array.isArray(value)) return value.map((v, i) => substituteDeep(v, env, secrets, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, env, secrets, `${where}.${k}`);
    return out;
  }
  return value;
}

/** Replace every secret value in a string with `***`. */
export function maskSecrets(text: string, secrets: ReadonlySet<string>): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
  return out;
}

export interface ResolvedEndpoint {
  name?: string;
  key?: string;
  method: string;
  /** URL with environment variables substituted (never print this). */
  url: string;
  /** URL as written in the config (safe to print). */
  displayUrl: string;
  headers: Record<string, string>;
  body?: string;
  samples: number;
  timeout: number;
  keepQuery?: string[];
}

/** Apply defaults and environment substitution to every configured endpoint. */
export function resolveEndpoints(
  config: DriftConfig,
  env: Record<string, string | undefined>,
  secrets: Set<string>,
  only?: readonly string[],
): ResolvedEndpoint[] {
  const d = config.defaults ?? {};
  const wanted = (e: EndpointConfig) =>
    !only?.length ||
    only.some((o) => {
      const q = o.toLowerCase();
      return (e.name ?? '').toLowerCase().includes(q) || e.url.toLowerCase().includes(q) || (e.key ?? '').toLowerCase().includes(q);
    });
  return config.endpoints.filter(wanted).map((e, i) => {
    const where = e.name ? `endpoint "${e.name}"` : `endpoints[${i}]`;
    const url = substituteEnv(e.url, env, secrets, `${where}.url`);
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    } catch {
      throw new ConfigError(`${where}.url is not an absolute http(s) URL: ${maskSecrets(url, secrets)}`);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...d.headers, ...e.headers })) {
      const value = substituteEnv(v, env, secrets, `${where}.headers.${k}`);
      // An empty value (e.g. "${TOKEN:-}" without TOKEN) means "do not send this header".
      if (value.trim() !== '') headers[k.toLowerCase()] = value;
    }
    const rawBody = e.body ?? d.body;
    let body: string | undefined;
    if (rawBody !== undefined) {
      const sub = substituteDeep(rawBody, env, secrets, `${where}.body`);
      body = typeof sub === 'string' ? sub : JSON.stringify(sub);
      if (typeof sub !== 'string' && !headers['content-type']) headers['content-type'] = 'application/json';
    }
    return {
      name: e.name,
      key: e.key,
      method: (e.method ?? d.method ?? 'GET').toUpperCase(),
      url,
      displayUrl: e.url,
      headers,
      body,
      samples: e.samples ?? d.samples ?? 1,
      timeout: e.timeout ?? d.timeout ?? 10_000,
      keepQuery: e.keepQuery ?? d.keepQuery,
    };
  });
}

/** The commented `api-drift.config.json` written by `api-drift init`. */
export function configTemplate(urls: readonly string[] = []): string {
  const custom = urls.map((u) => `    { "url": ${JSON.stringify(u)} },`).join('\n');
  const endpoints = custom
    ? `${custom}\n`
    : `    // Public endpoint, no auth needed.
    { "name": "npm: react", "url": "https://registry.npmjs.org/react/latest" },
`;
  return `{
  "$schema": "./node_modules/api-drift/schema/config.schema.json",

  // The learned contract. Commit it: it is what \`check\` compares against.
  "baseline": ".api-drift/baseline.json",

  // Applied to every endpoint unless the endpoint overrides it.
  "defaults": {
    "timeout": 10000,   // ms
    "samples": 1,       // calls per endpoint; more samples = better optional/required detection
    "headers": {
      "accept": "application/json"
    }
  },

  "endpoints": [
${endpoints}
    // \${ENV_VAR} is read from the environment; \${ENV_VAR:-fallback} gives a default.
    // Substituted values are masked in every report.
    // {
    //   "name": "GitHub repo",
    //   "url": "https://api.github.com/repos/nodejs/node",
    //   "headers": { "authorization": "Bearer \${GITHUB_TOKEN}" }
    // },

    // POST with a JSON body, sampled three times.
    // { "method": "POST", "url": "https://httpbin.org/anything", "body": { "q": "test" }, "samples": 3 },
  ],

  // Exit code 1 when a change of this severity (or worse) is found: breaking | risky | info | never
  "failOn": "breaking",

  "diff": {
    // Paths that change on purpose. Exact paths cover their children; * is a wildcard.
    "ignore": [],
    // Re-grade or silence change kinds, e.g. { "added": "ignore", "enum-added": "breaking" }
    "severity": {}
  }
}
`;
}
