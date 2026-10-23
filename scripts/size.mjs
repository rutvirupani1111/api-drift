// Measures every entry point minified + gzipped and enforces the size budget.
// Usage: node scripts/size.mjs   (exit 1 when a budget is exceeded)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const KB = 1024;
const entries = [
  { name: 'api-drift', file: 'src/index.ts', budget: 12 * KB },
  { name: 'api-drift/core', file: 'src/core/index.ts', budget: 14 * KB },
  { name: 'api-drift/report', file: 'src/report.ts', budget: 6 * KB },
  { name: 'api-drift/axios', file: 'src/axios.ts', budget: 2 * KB },
  { name: 'api-drift/node', file: 'src/node.ts' },
];

let failed = false;
console.log('entry               minified    min+gzip   budget');
for (const e of entries) {
  const out = await build({
    entryPoints: [`${root}/${e.file}`],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: e.name === 'api-drift/node' ? 'node' : 'neutral',
    external: ['node:*'],
    define: { __VERSION__: JSON.stringify(version) },
    write: false,
    logLevel: 'error',
  });
  const code = out.outputFiles[0].contents;
  const gz = gzipSync(code, { level: 9 }).length;
  const over = e.budget !== undefined && gz > e.budget;
  failed ||= over;
  const fmt = (n) => `${(n / KB).toFixed(2)} KB`.padStart(10);
  console.log(`${e.name.padEnd(18)} ${fmt(code.length)} ${fmt(gz)}   ${e.budget ? `${e.budget / KB} KB${over ? '  OVER BUDGET' : ''}` : '-'}`);
}
process.exitCode = failed ? 1 : 0;
