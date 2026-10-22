import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';

export const serverUrl = (): string => inject('serverUrl');

/** Register a JSON (or other) response on the shared test server. */
export async function mock(
  path: string,
  body: unknown,
  options: { status?: number; type?: string; delay?: number } = {},
): Promise<string> {
  const q = new URLSearchParams({ path, status: String(options.status ?? 200), type: options.type ?? 'application/json' });
  if (options.delay) q.set('delay', String(options.delay));
  const res = await fetch(`${serverUrl()}/__mock?${q}`, {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (res.status !== 204) throw new Error(`mock failed: ${res.status}`);
  return `${serverUrl()}${path}`;
}

export async function hits(path: string): Promise<number> {
  const res = await fetch(`${serverUrl()}/__count?path=${encodeURIComponent(path)}`);
  return Number(await res.text());
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the bundled CLI (`node cli.mjs ...`) in a directory. */
export function runCli(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<CliRun> {
  const cli = inject('cliPath');
  return new Promise((done) => {
    execFile(
      process.execPath,
      [cli, ...args],
      {
        cwd: options.cwd,
        // WT_SESSION makes Windows use Unicode symbols, so output is identical on every OS.
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', NO_COLOR: '1', WT_SESSION: '1', ...options.env },
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** A fresh temp directory, removed by the returned cleanup function. */
export function tempDir(prefix = 'api-drift-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['id', 'status', 'name', 'price', 'tags', 'meta', 'items', 'created_at', 'kind', 'note'];
const STRINGS = [
  'active',
  'paused',
  'archived',
  '2026-10-23T02:40:00Z',
  '2026-10-23',
  'person@example.com',
  'https://example.com/x',
  '550e8400-e29b-41d4-a716-446655440000',
  '',
  'free text with spaces',
  '12.50',
  'v1.2.3',
];

/**
 * A tiny random JSON generator for property tests (no fast-check needed).
 * Keeps a small vocabulary so that generated values overlap and merge meaningfully.
 */
export function genValue(next: () => number, depth = 0): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const r = next();
  if (depth > 3 || r < 0.45) {
    const p = next();
    if (p < 0.12) return null;
    if (p < 0.24) return next() < 0.5;
    if (p < 0.42) return Math.floor(next() * 200) - 50;
    if (p < 0.55) return Math.round(next() * 10000) / 100 - 10;
    return pick(STRINGS);
  }
  if (r < 0.7) {
    const n = Math.floor(next() * 4);
    return Array.from({ length: n }, () => genValue(next, depth + 1));
  }
  const obj: Record<string, unknown> = {};
  const n = 1 + Math.floor(next() * 5);
  for (let i = 0; i < n; i++) obj[pick(KEYS)] = genValue(next, depth + 1);
  return obj;
}
