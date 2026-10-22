import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core/index';
import * as main from '../src/index';
import * as node from '../src/node';
import * as report from '../src/report';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function bundle(entry: string) {
  const out = await build({
    entryPoints: [new URL(`../${entry}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    metafile: true,
    logLevel: 'silent',
    define: { __VERSION__: '"test"' },
  });
  const imports = Object.values(out.metafile!.inputs).flatMap((i) => i.imports.map((x) => x.path));
  return { code: out.outputFiles[0].text, imports, gzip: gzipSync(out.outputFiles[0].contents, { level: 9 }).length };
}

describe('package', () => {
  it('has zero runtime dependencies and is side-effect free', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.license).toBe('MIT');
    expect(Object.keys(pkg.exports)).toEqual(['.', './core', './report', './axios', './node', './schema.json', './package.json']);
    expect(pkg.bin['api-drift']).toBe('dist/cli.js');
  });

  it.each(['src/core/index.ts', 'src/index.ts', 'src/report.ts', 'src/axios.ts'])(
    '%s is browser-safe (no Node built-ins) and under 12 KB min+gzip',
    async (entry) => {
      const { imports, code, gzip } = await bundle(entry);
      expect(imports.filter((p) => p.startsWith('node:'))).toEqual([]);
      expect(code).not.toMatch(/\brequire\(/);
      expect(code).not.toMatch(/\bprocess\.(env|stdout|stderr|exit)/);
      expect(gzip).toBeLessThan(12 * 1024);
    },
  );

  it('the composite action never interpolates inputs into its script', () => {
    const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
    expect(action).toContain('using: composite');
    const script = action.slice(action.indexOf('run: |'));
    expect(script).not.toContain('${{');
    expect(action).toContain('--format markdown');
    expect(action).toContain('GITHUB_STEP_SUMMARY');
  });

  it('ships a config JSON schema that knows every change kind', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/config.schema.json', import.meta.url), 'utf8'));
    const kinds = schema.properties.diff.properties.severity.propertyNames.enum;
    expect([...kinds].sort()).toEqual(Object.keys(core.DEFAULT_SEVERITY).sort());
    expect(pkg.files).toContain('schema');
  });

  it('exposes the documented API surface', () => {
    for (const name of ['infer', 'merge', 'diff', 'generateTypes', 'importHar', 'endpointKey', 'parseBaseline', 'diffBaselines']) {
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
    for (const name of ['renderText', 'renderMarkdown', 'renderJson', 'buildReport', 'renderShapeTree', 'explainEntry', 'createStyle']) {
      expect(typeof (report as Record<string, unknown>)[name]).toBe('function');
    }
    for (const name of ['createDrift', 'memoryStore', 'localStorageStore', 'consoleReporter', 'webhookReporter', 'infer', 'diff']) {
      expect(typeof (main as Record<string, unknown>)[name]).toBe('function');
    }
    for (const name of ['fileStore', 'jsonlReporter', 'runSnapshot', 'runCheck', 'runCli', 'loadConfig', 'renderMarkdown']) {
      expect(typeof (node as Record<string, unknown>)[name]).toBe('function');
    }
    expect(core.VERSION).toBe(pkg.version);
  });
});
