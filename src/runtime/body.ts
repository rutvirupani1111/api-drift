/** The parts of a fetch `Response` api-drift reads. */
export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  clone(): ResponseLike;
  text(): Promise<string>;
}

/**
 * Read a response body as text, giving up (and cancelling the stream) once
 * `maxBytes` is exceeded. Returns undefined when the body is too large.
 */
export async function readTextCapped(res: ResponseLike, maxBytes: number): Promise<string | undefined> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    return text.length > maxBytes ? undefined : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      // Never await this: cancelling one branch of a clone()d (tee'd) body only
      // settles once the caller's branch is consumed or cancelled too.
      reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Run `fn` on a later macrotask so it never competes with the caller's continuation. */
export function later<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        Promise.resolve(fn()).then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    }, 0);
  });
}
