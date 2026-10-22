import { createBaseline, learnEntry, type Baseline, type BaselineEntry } from './baseline';
import { endpointKey } from './endpoint';
import { DEFAULT_LIMITS, infer, type InferOptions } from './infer';
import { compileMatchers, type Matcher } from './match';
import { createMap, own } from './util';

/** The subset of the HAR 1.2 format api-drift reads. */
export interface HarLike {
  log: {
    entries: Array<{
      startedDateTime?: string;
      request: { method?: string; url: string };
      response: {
        status: number;
        headers?: Array<{ name: string; value: string }>;
        content?: { mimeType?: string; text?: string; encoding?: string; size?: number };
      };
    }>;
  };
}

export interface HarImportOptions extends InferOptions {
  /** Only import matching URLs (see `Matcher`). */
  include?: Matcher | Matcher[];
  exclude?: Matcher | Matcher[];
  /** Query parameters to keep in endpoint keys. */
  keepQuery?: string[];
  /** Custom endpoint key; return null/undefined to skip the entry. */
  keyFor?: (request: { method: string; url: string; status: number }) => string | null | undefined;
  /** Merge into this baseline instead of starting empty. */
  baseline?: Baseline;
}

export type HarSkipReason = 'no-response' | 'not-json' | 'no-body' | 'too-large' | 'invalid-json' | 'filtered';

export interface HarImportStats {
  entries: number;
  /** Entries whose responses were learned. */
  learned: number;
  skipped: number;
  /** Distinct endpoint keys learned in this import. */
  endpoints: number;
  reasons: Partial<Record<HarSkipReason, number>>;
}

export interface HarImportResult {
  baseline: Baseline;
  stats: HarImportStats;
  /** Endpoint keys learned in this import, with how many responses each got. */
  learnedKeys: Record<string, number>;
}

function decodeBase64(text: string): string {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Build (or extend) a baseline from a browser HAR export: every JSON response is
 * grouped by endpoint key and merged. Record a session in DevTools, get a contract.
 * Browser-safe: works on a parsed object or the raw HAR text.
 */
export function importHar(har: string | HarLike, options: HarImportOptions = {}): HarImportResult {
  const data = (typeof har === 'string' ? JSON.parse(har) : har) as Partial<HarLike>;
  const entries = data?.log?.entries;
  if (!Array.isArray(entries)) throw new TypeError('Not a HAR file: missing log.entries');
  const allowed = compileMatchers(options.include, options.exclude);
  const maxBytes = options.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes;
  const base = options.baseline ?? createBaseline();
  const endpoints = createMap<BaselineEntry>();
  for (const k of Object.keys(base.endpoints)) endpoints[k] = base.endpoints[k];
  const stats: HarImportStats = { entries: entries.length, learned: 0, skipped: 0, endpoints: 0, reasons: {} };
  const learnedKeys = createMap<number>();
  let latest = base.updatedAt;
  const skip = (reason: HarSkipReason) => {
    stats.skipped++;
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
  };

  for (const entry of entries) {
    const req = entry?.request;
    const res = entry?.response;
    if (!req?.url || !res || !res.status) {
      skip('no-response');
      continue;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      skip('filtered');
      continue;
    }
    if (!allowed(url, method)) {
      skip('filtered');
      continue;
    }
    const header = res.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
    const mime = res.content?.mimeType || header;
    if (!/json/i.test(mime)) {
      skip('not-json');
      continue;
    }
    let text = res.content?.text;
    if (!text) {
      skip('no-body');
      continue;
    }
    if (text.length > maxBytes * (res.content?.encoding === 'base64' ? 1.4 : 1)) {
      skip('too-large');
      continue;
    }
    let value: unknown;
    try {
      if (res.content?.encoding === 'base64') text = decodeBase64(text);
      value = JSON.parse(text);
    } catch {
      skip('invalid-json');
      continue;
    }
    const key = options.keyFor
      ? options.keyFor({ method, url: req.url, status: res.status })
      : endpointKey({ method, url, status: res.status }, { keepQuery: options.keepQuery });
    if (!key) {
      skip('filtered');
      continue;
    }
    const shape = infer(value, options);
    if (shape.kind === 'unknown') {
      skip('too-large');
      continue;
    }
    endpoints[key] = learnEntry(own(endpoints, key), shape, {
      at: entry.startedDateTime,
      example: req.url,
      enumMaxValues: options.enumMaxValues,
    });
    if (!latest || endpoints[key].lastSeen > latest) latest = endpoints[key].lastSeen;
    learnedKeys[key] = (learnedKeys[key] ?? 0) + 1;
    stats.learned++;
  }
  stats.endpoints = Object.keys(learnedKeys).length;
  return { baseline: { ...base, updatedAt: latest, endpoints }, stats, learnedKeys };
}
