import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: { __VERSION__: JSON.stringify(version) },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
