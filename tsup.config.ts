import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const define = { __VERSION__: JSON.stringify(version) };

export default defineConfig([
  {
    // Library entry points: ESM + CJS + .d.ts, platform-neutral so the
    // browser-facing entries never pull in Node built-ins.
    entry: {
      index: 'src/index.ts',
      core: 'src/core/index.ts',
      report: 'src/report.ts',
      axios: 'src/axios.ts',
      node: 'src/node.ts',
    },
    format: ['esm', 'cjs'],
    platform: 'neutral',
    target: 'es2020',
    external: [/^node:/],
    dts: true,
    splitting: true,
    sourcemap: false,
    treeshake: true,
    clean: false,
    define,
  },
  {
    // The CLI: a single ESM file with a shebang.
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    define,
  },
]);
