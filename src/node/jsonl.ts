import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Reporter } from '../runtime/types';

/** Append every drift event as one JSON line (for log shippers, `jq`, dashboards). */
export function jsonlReporter(path: string): Reporter {
  const file = resolve(path);
  let chain: Promise<void> = Promise.resolve();
  return (event) => {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
      });
    return chain;
  };
}
