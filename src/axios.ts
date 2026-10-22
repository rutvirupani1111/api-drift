/**
 * api-drift/axios: a duck-typed response interceptor. No axios dependency;
 * works with any axios instance (v0.x and v1.x).
 *
 *   import axios from 'axios';
 *   import { attachAxios } from 'api-drift/axios';
 *   const detach = attachAxios(drift, axios);
 */
import type { Drift, ObservedResponse } from './runtime/drift';

interface AxiosHeadersLike {
  get?: (name: string) => unknown;
  [name: string]: unknown;
}

export interface AxiosResponseLike {
  status: number;
  data: unknown;
  headers?: AxiosHeadersLike;
  config?: { method?: string; url?: string; baseURL?: string; params?: unknown };
  request?: { responseURL?: string; res?: { responseUrl?: string } };
}

export interface AxiosLike {
  interceptors: {
    response: {
      use(
        onFulfilled?: (response: any) => any,
        onRejected?: (error: any) => any,
      ): number;
      eject(id: number): void;
    };
  };
}

function header(headers: AxiosHeadersLike | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const v = typeof headers.get === 'function' ? headers.get(name) : (headers[name] ?? headers[name.toLowerCase()]);
  return typeof v === 'string' ? v : undefined;
}

function combine(baseURL: string | undefined, url: string | undefined): string {
  const u = url ?? '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(u) || !baseURL) return u;
  return `${baseURL.replace(/\/+$/, '')}/${u.replace(/^\/+/, '')}`;
}

/** Translate an axios response into the shape `drift.observe` expects. */
export function fromAxiosResponse(response: AxiosResponseLike): ObservedResponse {
  const config = response.config ?? {};
  let url = response.request?.responseURL || response.request?.res?.responseUrl || combine(config.baseURL, config.url);
  const params = config.params;
  if (params && typeof params === 'object' && !(params instanceof URLSearchParams) && !response.request?.responseURL) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  return {
    method: (config.method ?? 'get').toUpperCase(),
    url,
    status: response.status,
    contentType: header(response.headers, 'content-type'),
    body: response.data,
  };
}

/**
 * Observe every response (including error responses) of an axios instance.
 * The interceptor never changes, delays or throws on a response.
 * Returns a function that removes the interceptor.
 */
export function attachAxios(drift: Drift, axios: AxiosLike): () => void {
  const watch = (response: AxiosResponseLike | undefined) => {
    try {
      if (response && typeof response.status === 'number') drift.observe(fromAxiosResponse(response));
    } catch {
      // never let instrumentation affect the caller
    }
  };
  const id = axios.interceptors.response.use(
    (response: AxiosResponseLike) => {
      watch(response);
      return response;
    },
    (error: { response?: AxiosResponseLike }) => {
      watch(error?.response);
      return Promise.reject(error);
    },
  );
  return () => axios.interceptors.response.eject(id);
}

/** Alias of `attachAxios`. */
export const axiosDrift = attachAxios;
