import { describe, expect, it } from 'vitest';
import { attachAxios, axiosDrift, fromAxiosResponse, type AxiosLike, type AxiosResponseLike } from '../src/axios';
import { createDrift, type ObservedResponse } from '../src/runtime/drift';

/** A minimal stand-in for an axios instance's interceptor chain. */
function fakeAxios() {
  const handlers = new Map<number, { ok?: (r: any) => any; err?: (e: any) => any }>();
  let next = 0;
  const instance: AxiosLike & { respond(r: AxiosResponseLike): Promise<unknown>; fail(e: unknown): Promise<unknown>; count(): number } = {
    interceptors: {
      response: {
        use(ok, err) {
          handlers.set(++next, { ok, err });
          return next;
        },
        eject(id) {
          handlers.delete(id);
        },
      },
    },
    async respond(r) {
      let v: unknown = r;
      for (const h of handlers.values()) v = h.ok ? await h.ok(v) : v;
      return v;
    },
    async fail(e) {
      let p: Promise<unknown> = Promise.reject(e);
      for (const h of handlers.values()) p = p.catch((x) => (h.err ? h.err(x) : Promise.reject(x)));
      return p;
    },
    count: () => handlers.size,
  };
  return instance;
}

const response = (over: Partial<AxiosResponseLike> = {}): AxiosResponseLike => ({
  status: 200,
  data: { id: 1, plan: 'pro' },
  headers: { 'content-type': 'application/json; charset=utf-8' },
  config: { method: 'get', baseURL: 'https://api.test/v1/', url: '/users/1', params: { expand: 'team', skip: undefined } },
  ...over,
});

describe('fromAxiosResponse', () => {
  it('joins baseURL, url and params like axios does', () => {
    expect(fromAxiosResponse(response())).toEqual({
      method: 'GET',
      url: 'https://api.test/v1/users/1?expand=team',
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { id: 1, plan: 'pro' },
    });
  });

  it('prefers the final URL from the request and AxiosHeaders.get()', () => {
    const headers = { get: (n: string) => (n === 'content-type' ? 'application/json' : undefined) };
    const r = fromAxiosResponse(response({ headers, request: { responseURL: 'https://cdn.test/final/1' } }));
    expect(r.url).toBe('https://cdn.test/final/1');
    expect(r.contentType).toBe('application/json');
  });

  it('keeps absolute urls and defaults the method', () => {
    const r = fromAxiosResponse({ status: 201, data: {}, config: { url: 'https://x.test/a', baseURL: 'https://ignored.test' } });
    expect(r).toMatchObject({ method: 'GET', url: 'https://x.test/a', contentType: undefined });
  });
});

describe('attachAxios', () => {
  it('observes successes and error responses without altering them', async () => {
    const seen: ObservedResponse[] = [];
    const drift = { observe: (r: ObservedResponse) => seen.push(r) } as unknown as Parameters<typeof attachAxios>[0];
    const axios = fakeAxios();
    const detach = attachAxios(drift, axios);
    const ok = response();
    expect(await axios.respond(ok)).toBe(ok);
    const error = Object.assign(new Error('Request failed with status code 404'), { response: response({ status: 404, data: { error: 'nf' } }) });
    await expect(axios.fail(error)).rejects.toBe(error);
    expect(seen.map((s) => s.status)).toEqual([200, 404]);
    detach();
    expect(axios.count()).toBe(0);
  });

  it('never throws even when observe does', async () => {
    const drift = {
      observe: () => {
        throw new Error('boom');
      },
    } as unknown as Parameters<typeof attachAxios>[0];
    const axios = fakeAxios();
    axiosDrift(drift, axios);
    const ok = response();
    expect(await axios.respond(ok)).toBe(ok);
    await expect(axios.fail(new Error('no response'))).rejects.toThrow('no response');
  });

  it('feeds a real drift instance', async () => {
    const drift = createDrift({ mode: 'learn' });
    const axios = fakeAxios();
    attachAxios(drift, axios);
    await axios.respond(response());
    await drift.flush();
    expect(await drift.store.list()).toEqual(['GET api.test /v1/users/:id 2xx']);
  });
});
