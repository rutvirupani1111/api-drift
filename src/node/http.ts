import { VERSION } from '../version';
import { readTextCapped, type ResponseLike } from '../runtime/body';
import type { ResolvedEndpoint } from './config';

export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

export interface CallResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  durationMs: number;
  value?: unknown;
  error?: string;
}

export interface CallOptions {
  fetch?: FetchLike;
  maxPayloadBytes: number;
  /** Retries for network errors and timeouts (not for HTTP error statuses). Default 1. */
  retries?: number;
}

function describeError(e: unknown, timeout: number): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timed out after ${timeout} ms`;
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${err.message ?? 'request failed'} (${cause})` : (err?.message ?? String(e));
}

/** Call one configured endpoint and parse its JSON body (bounded in size). */
export async function callEndpoint(ep: ResolvedEndpoint, options: CallOptions): Promise<CallResult> {
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const retries = options.retries ?? 1;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': `api-drift/${VERSION} (+https://www.npmjs.com/package/api-drift)`,
    ...ep.headers,
  };
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    try {
      const res = await fetchFn(ep.url, {
        method: ep.method,
        headers,
        body: ep.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(ep.timeout),
      });
      const text = await readTextCapped(res, options.maxPayloadBytes);
      const durationMs = performance.now() - started;
      const contentType = res.headers.get('content-type') ?? '';
      const base = { status: res.status, contentType, durationMs };
      if (text === undefined) {
        return { ok: false, ...base, error: `response larger than ${options.maxPayloadBytes} bytes (raise maxPayloadBytes)` };
      }
      if (text.trim() === '') return { ok: false, ...base, error: `empty response body (HTTP ${res.status})` };
      try {
        return { ok: true, ...base, value: JSON.parse(text) };
      } catch {
        return { ok: false, ...base, error: `expected JSON but got ${contentType || 'no content-type'} (HTTP ${res.status})` };
      }
    } catch (e) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return { ok: false, durationMs: performance.now() - started, error: describeError(e, ep.timeout) };
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
