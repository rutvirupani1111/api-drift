import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';

/** Port reserved for api-drift tests. */
export const PORT = 5184;

declare module 'vitest' {
  export interface ProvidedContext {
    cliPath: string;
    serverUrl: string;
  }
}

interface MockResponse {
  status: number;
  type: string;
  body: string;
  delay: number;
}

/**
 * A programmable local HTTP server shared by every test file:
 *   PUT /__mock?path=/x/y&status=200&type=application/json   (body = response body)
 *   GET /__count?path=/x/y                                    (number of hits)
 *   GET /fixed/echo        echoes method, headers and body
 *   GET /fixed/big         a chunked JSON body of ~1.5 MB (no content-length)
 *   GET /fixed/html        text/html
 */
function startServer(): Promise<() => Promise<void>> {
  const mocks = new Map<string, MockResponse>();
  const hits = new Map<string, number>();
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((done) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const body = await readBody(req);
    if (url.pathname === '/__mock' && req.method === 'PUT') {
      const path = url.searchParams.get('path') ?? '/';
      mocks.set(path, {
        status: Number(url.searchParams.get('status') ?? 200),
        type: url.searchParams.get('type') ?? 'application/json',
        delay: Number(url.searchParams.get('delay') ?? 0),
        body,
      });
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/__count') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(String(hits.get(url.searchParams.get('path') ?? '') ?? 0));
      return;
    }
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    if (url.pathname === '/fixed/echo') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ method: req.method, headers: req.headers, body, query: Object.fromEntries(url.searchParams) }),
      );
      return;
    }
    if (url.pathname === '/fixed/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"items":[');
      for (let i = 0; i < 15_000; i++) res.write(`${i ? ',' : ''}{"id":${i},"name":"item number ${i} with padding padding padding padding padding"}`);
      res.end(']}');
      return;
    }
    if (url.pathname === '/fixed/html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>hello</p>');
      return;
    }
    const mock = mocks.get(url.pathname);
    if (!mock) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found', path: url.pathname }));
      return;
    }
    if (mock.delay) await new Promise((r) => setTimeout(r, mock.delay));
    res.writeHead(mock.status, { 'content-type': mock.type }).end(mock.body);
  });
  return new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(PORT, '127.0.0.1', () =>
      ready(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      ),
    );
  });
}

export default async function setup(project: TestProject) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const outDir = join(tmpdir(), `api-drift-test-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const cliPath = join(outDir, 'cli.mjs');
  await build({
    entryPoints: [join(root, 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: cliPath,
    define: { __VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
  });
  const stop = await startServer();
  project.provide('cliPath', cliPath);
  project.provide('serverUrl', `http://127.0.0.1:${PORT}`);
  return async () => {
    await stop();
    rmSync(outDir, { recursive: true, force: true });
  };
}
