#!/usr/bin/env node
import { main } from './cli/main';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`api-drift: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exitCode = 2;
  },
);
