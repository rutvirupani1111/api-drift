import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli/main';
import { parseBaseline } from '../src/core/baseline';
import { parseJsonc } from '../src/node/jsonc';
import { mock, runCli, serverUrl, tempDir } from './helpers';

const HAR = new URL('./fixtures/session.har', import.meta.url);

function workspace() {
  const t = tempDir('api-drift-cli-');
  const cli = (args: string[], env?: Record<string, string>) => runCli(args, { cwd: t.dir, env });
  const write = (name: string, content: unknown) =>
    writeFileSync(join(t.dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  const read = (name: string) => readFileSync(join(t.dir, name), 'utf8');
  const config = (endpoints: unknown[], extra: Record<string, unknown> = {}) => write('api-drift.config.json', { endpoints, ...extra });
  return { ...t, cli, write, read, config };
}

describe('cli: basics', () => {
  const ws = workspace();
  afterAll(ws.cleanup);

  it('prints the version and help', async () => {
    expect((await ws.cli(['--version'])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = await ws.cli(['--help']);
    expect(help.code).toBe(0);
    for (const c of ['init', 'snapshot', 'check', 'import-har', 'diff', 'types', 'openapi', 'explain']) expect(help.stdout).toContain(c);
    const sub = await ws.cli(['help', 'check']);
    expect(sub.stdout).toContain('--fail-on <level>');
    expect((await ws.cli(['types', '--help'])).stdout).toContain('--zod');
  });

  it('suggests the closest command and option', async () => {
    const r = await ws.cli(['chek']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown command "chek". Did you mean check?');
    const o = await ws.cli(['check', '--fail-of', 'risky']);
    expect(o.code).toBe(2);
    expect(o.stderr).toContain('Unknown option --fail-of for check. Did you mean --fail-on?');
    const v = await ws.cli(['check', '--format']);
    expect(v.stderr).toContain('--format needs a value');
  });
});

describe('cli: init', () => {
  const ws = workspace();
  afterAll(ws.cleanup);

  it('writes a commented config, refuses to overwrite, and adds URLs', async () => {
    const r = await ws.cli(['init']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✔ Created api-drift.config.json');
    expect(ws.read('api-drift.config.json')).toContain('// ');
    expect((await ws.cli(['init'])).code).toBe(2);
    expect((await ws.cli(['init', 'https://a.test/x', '--force'])).code).toBe(0);
    expect((parseJsonc(ws.read('api-drift.config.json')) as { endpoints: Array<{ url: string }> }).endpoints).toEqual([{ url: 'https://a.test/x' }]);
    const bad = await ws.cli(['init', 'not-a-url', '--force']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('Not an http(s) URL');
  });
});

describe('cli: snapshot and check', () => {
  const ws = workspace();
  let url = '';
  const KEY = 'GET 127.0.0.1:5184 /cli-flow/repos/:id 2xx';
  const repo = { id: 1, name: 'node', owner: { login: 'nodejs' }, topics: ['js'], license: { key: 'mit' }, homepage: 'https://nodejs.org' };

  beforeAll(async () => {
    url = await mock('/cli-flow/repos/42', repo);
  });
  afterAll(ws.cleanup);

  it('snapshot records the baseline', async () => {
    await ws.cli(['init', url]);
    const r = await ws.cli(['snapshot']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('api-drift snapshot · 1 endpoint');
    expect(r.stdout).toMatch(new RegExp(`✔ ${KEY.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s+200 · \\d+ ms · 8 fields`));
    expect(r.stdout).toContain('Baseline written to .api-drift/baseline.json (1 endpoint)');
    const b = parseBaseline(ws.read('.api-drift/baseline.json'));
    expect(Object.keys(b.endpoints)).toEqual([KEY]);
    expect(b.endpoints[KEY].example).toBe(url);
  });

  it('check passes while nothing changed', async () => {
    const r = await ws.cli(['check']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`✔ ${KEY}  no drift`);
    expect(r.stdout.trim().split('\n').pop()).toBe('0 breaking · 0 risky · 0 info   PASS');
  });

  it('check fails on a breaking change and explains it', async () => {
    await mock('/cli-flow/repos/42', { ...repo, name: undefined, license: null, stars: 5 });
    const r = await ws.cli(['check']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`✖ ${KEY}  1 breaking · 1 risky · 1 info`);
    expect(r.stdout).toContain('✖ breaking  $.name     field is missing (was present in the baseline sample)');
    expect(r.stdout).toContain('▲ risky     $.license  can now be null (was object)');
    expect(r.stdout).toContain('● info      $.stars    new field (integer)');
    expect(r.stdout).toContain('FAIL (--fail-on breaking)');
  });

  it('--fail-on decides the exit code', async () => {
    expect((await ws.cli(['check', '--fail-on', 'never'])).code).toBe(0);
    expect((await ws.cli(['check', '--fail-on', 'risky'])).code).toBe(1);
    expect((await ws.cli(['check', '--fail-on', 'loud'])).code).toBe(2);
  });

  it('--format json and markdown, plus --json-file', async () => {
    const j = await ws.cli(['check', '--format', 'json', '--json-file', 'out/report.json']);
    const report = JSON.parse(j.stdout);
    expect(report.summary).toMatchObject({ endpoints: 1, breaking: 1, risky: 1, info: 1 });
    expect(report.failed).toBe(true);
    expect(JSON.parse(ws.read('out/report.json')).summary.breaking).toBe(1);
    const md = await ws.cli(['check', '--format', 'markdown']);
    expect(md.stdout).toContain('## API drift report: ✖ Failed');
    expect(md.stdout).toContain('| ✖ **breaking** | `$.name` | field is missing (was present in the baseline sample) |');
  });

  it('--update accepts the drift into the baseline', async () => {
    expect((await ws.cli(['check', '--update'])).code).toBe(1);
    const after = await ws.cli(['check']);
    expect(after.code).toBe(0);
  });

  it('reports a status class change as breaking', async () => {
    await mock('/cli-flow/repos/42', { message: 'Server Error' }, { status: 500 });
    const r = await ws.cli(['check']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('status changed from 2xx to 5xx');
    await mock('/cli-flow/repos/42', repo);
  });

  it('reports endpoints missing from the baseline as new (not failing)', async () => {
    const extra = await mock('/cli-flow/extra', { ok: true });
    ws.config([{ url }, { name: 'Extra', url: extra }]);
    const r = await ws.cli(['check', '--fail-on', 'risky', '--only', 'extra']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('new endpoint, not in baseline');
  });
});

describe('cli: configuration and failures', () => {
  const ws = workspace();
  afterAll(ws.cleanup);

  it('substitutes ${ENV} and never prints or stores the secret', async () => {
    ws.config([{ name: 'Echo', url: `${serverUrl()}/fixed/echo?token=\${TOKEN}`, headers: { 'x-api-key': '${TOKEN}' } }]);
    const env = { TOKEN: 'supersecret-token-123' };
    const r = await ws.cli(['snapshot'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('supersecret');
    expect(ws.read('.api-drift/baseline.json')).not.toContain('supersecret');
    const c = await ws.cli(['check', '--format', 'json'], env);
    expect(c.code).toBe(0);
    expect(c.stdout).not.toContain('supersecret');
    expect(JSON.parse(c.stdout).endpoints[0].url).toContain('${TOKEN}');
  });

  it('names a missing environment variable', async () => {
    const r = await ws.cli(['snapshot']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Environment variable TOKEN is not set');
  });

  it('reports non-JSON and unreachable endpoints but keeps the good ones', async () => {
    const good = await mock('/cli-fail/good', { ok: true });
    ws.config([{ url: good }, { name: 'html', url: `${serverUrl()}/fixed/html` }, { name: 'down', url: 'http://127.0.0.1:9/nothing' }]);
    const r = await ws.cli(['snapshot']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('error: expected JSON but got text/html (HTTP 200)');
    expect(r.stdout).toMatch(/error: fetch failed/);
    expect(r.stdout).toContain('Baseline written to .api-drift/baseline.json (1 endpoint)');
    const c = await ws.cli(['check', '--format', 'json']);
    expect(c.code).toBe(2);
    expect(JSON.parse(c.stdout).summary.errors).toBe(2);
  });

  it('a fresh snapshot replaces a corrupt baseline, --merge refuses to', async () => {
    const good = await mock('/cli-fail/replace', { ok: true });
    ws.config([{ url: good }]);
    mkdirSync(join(ws.dir, '.api-drift'), { recursive: true });
    ws.write('.api-drift/baseline.json', '{ corrupt');
    const merge = await ws.cli(['snapshot', '--merge']);
    expect(merge.code).toBe(2);
    expect(merge.stderr).toContain('not valid JSON');
    expect((await ws.cli(['snapshot'])).code).toBe(0);
    expect(parseBaseline(ws.read('.api-drift/baseline.json')).version).toBe(1);
  });

  it('explains missing config and baseline', async () => {
    const empty = workspace();
    try {
      const s = await empty.cli(['snapshot']);
      expect(s.code).toBe(2);
      expect(s.stderr).toContain('Run `api-drift init`');
      empty.config([{ url: 'https://x.test' }]);
      const c = await empty.cli(['check']);
      expect(c.code).toBe(2);
      expect(c.stderr).toContain('No baseline at .api-drift/baseline.json. Run `api-drift snapshot` first.');
      expect((await empty.cli(['snapshot', '--samples', 'lots'])).code).toBe(2);
    } finally {
      empty.cleanup();
    }
  });
});

describe('cli: import-har, types, explain', () => {
  const ws = workspace();
  beforeAll(() => copyFileSync(HAR, join(ws.dir, 'session.har')));
  afterAll(ws.cleanup);

  it('import-har builds a baseline from a recorded session', async () => {
    const r = await ws.cli(['import-har', 'session.har']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✔ 7 JSON responses learned from 12 entries (5 skipped: 2 not-json, 1 no-body, 1 invalid-json, 1 no-response)');
    expect(r.stdout).toMatch(/GET api\.shop\.test \/api\/users\/:id 2xx\s+3 responses · 7 fields/);
    expect(r.stdout).toContain('Baseline written to .api-drift/baseline.json (4 endpoints)');
    const j = await ws.cli(['import-har', 'session.har', '--format', 'json', '--include', 'api.shop.test', '--exclude', '/cart/']);
    expect(JSON.parse(j.stdout).stats.learned).toBe(6);
    ws.write('not.har', '{"hello":1}');
    expect((await ws.cli(['import-har', 'not.har'])).code).toBe(2);
    expect((await ws.cli(['import-har'])).code).toBe(2);
  });

  it('types prints TypeScript and writes Zod', async () => {
    await ws.cli(['import-har', 'session.har']);
    const t = await ws.cli(['types']);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('export interface GetApiUsersByIdResponse {');
    expect(t.stdout).toContain('nickname?: string;');
    const z = await ws.cli(['types', '--zod', '--out', 'src/schemas.ts', '--endpoint', 'cart']);
    expect(z.stdout).toContain('✔ Wrote Zod schemas for 1 endpoint to src/schemas.ts');
    expect(ws.read('src/schemas.ts')).toContain("import { z } from 'zod';");
    expect((await ws.cli(['types', '--endpoint', 'nothing-matches'])).code).toBe(2);
  });

  it('openapi prints JSON, writes YAML and honours the flags', async () => {
    await ws.cli(['import-har', 'session.har']);
    const j = await ws.cli(['openapi']);
    expect(j.code).toBe(0);
    const doc = JSON.parse(j.stdout);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('api.shop.test');
    expect(doc.servers).toEqual([{ url: 'https://api.shop.test' }]);
    expect(Object.keys(doc.paths['/api/users/{userId}'].get.responses)).toEqual(['2XX', '4XX']);
    expect(j.stdout).not.toContain('example');
    const again = await ws.cli(['openapi']);
    expect(again.stdout).toBe(j.stdout);
    const y = await ws.cli(['openapi', '--out', 'spec/openapi.yaml', '--title', 'Shop API', '--api-version', '2.0.0', '--endpoint', 'users']);
    expect(y.code).toBe(0);
    expect(y.stdout).toContain('✔ Wrote OpenAPI 3.1 (YAML): 1 path, 1 operation to spec/openapi.yaml');
    const yaml = ws.read('spec/openapi.yaml');
    expect(yaml.startsWith('openapi: 3.1.0\ninfo:\n')).toBe(true);
    expect(yaml).toContain('  title: Shop API\n');
    expect(yaml).toContain('  version: 2.0.0\n');
    expect(yaml).not.toContain('/api/cart');
    expect((await ws.cli(['openapi', '--yaml'])).stdout.startsWith('openapi: 3.1.0\n')).toBe(true);
    expect((await ws.cli(['openapi', '--endpoint', 'nothing-matches'])).code).toBe(2);
    expect((await ws.cli(['openapi', '--help'])).stdout).toContain('--yaml');
  });

  it('explain lists endpoints, prints trees and handles ambiguity', async () => {
    const list = await ws.cli(['explain']);
    expect(list.stdout).toContain('.api-drift/baseline.json · 4 endpoints');
    expect(list.stdout).toMatch(/POST api\.shop\.test \/api\/cart 2xx\s+1 sample · 3 fields/);
    const one = await ws.cli(['explain', 'cart']);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain('POST api.shop.test /api/cart 2xx');
    expect(one.stdout).toContain('├─ cart_id');
    const amb = await ws.cli(['explain', 'users']);
    expect(amb.code).toBe(2);
    expect(amb.stderr).toContain('"users" matches 2 endpoints');
    expect((await ws.cli(['explain', 'zzz'])).stderr).toContain('No endpoint matches "zzz"');
    const json = JSON.parse((await ws.cli(['explain', 'cart', '--format', 'json'])).stdout);
    expect(json.shape.kind).toBe('object');
  });
});

describe('cli: diff', () => {
  const ws = workspace();
  afterAll(ws.cleanup);

  it('diffs two payloads', async () => {
    ws.write('a.json', { id: 1, name: 'x', tags: ['a'] });
    ws.write('b.json', { id: '1', tags: ['a'], extra: true });
    const r = await ws.cli(['diff', 'a.json', 'b.json']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('a.json → b.json');
    expect(r.stdout).toContain('type changed from integer to string<numeric-string>');
    expect(r.stdout).toContain('field is missing');
    expect((await ws.cli(['diff', 'a.json', 'b.json', '--fail-on', 'never'])).code).toBe(0);
    expect((await ws.cli(['diff', 'a.json', 'a.json'])).code).toBe(0);
  });

  it('diffs two baselines and a baseline against a payload', async () => {
    copyFileSync(HAR, join(ws.dir, 'session.har'));
    await ws.cli(['import-har', 'session.har', '--out', 'one.json']);
    ws.write('two.json', ws.read('one.json').replace(/"kind": "integer"/, '"kind": "string",\n"formats": ["plain"]'));
    const r = await ws.cli(['diff', 'one.json', 'two.json', '--format', 'markdown']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('type changed from integer to string');
    ws.write('payload.json', { cart_id: 'c1', items: '1', subtotal: 3 });
    const p = await ws.cli(['diff', 'one.json', 'payload.json', '--endpoint', 'cart']);
    expect(p.code).toBe(1);
    expect(p.stdout).toContain('$.items');
    expect((await ws.cli(['diff', 'one.json', 'payload.json'])).code).toBe(2);
    expect((await ws.cli(['diff', 'one.json'])).code).toBe(2);
  });
});

describe('cli: in-process main()', () => {
  it('colours output when FORCE_COLOR is set and stays plain with --no-color', async () => {
    let out = '';
    const io = { stdout: { write: (s: string) => (out += s), isTTY: false }, stderr: { write: () => true }, cwd: process.cwd() };
    expect(await main(['--help'], { ...io, env: { FORCE_COLOR: '1' } })).toBe(0);
    expect(out).toContain('\u001b[');
    out = '';
    await main(['--help', '--no-color'], { ...io, env: { FORCE_COLOR: '1' } });
    expect(out).not.toContain('\u001b[');
  });

  it('never leaves files behind on failure', async () => {
    const ws = workspace();
    try {
      let err = '';
      const code = await main(['check'], { cwd: ws.dir, env: {}, stdout: { write: () => true }, stderr: { write: (s: string) => (err += s) } });
      expect(code).toBe(2);
      expect(err).toContain('No config file');
      expect(existsSync(join(ws.dir, '.api-drift'))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});
