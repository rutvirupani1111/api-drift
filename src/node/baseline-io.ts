import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseBaseline, serializeBaseline, type Baseline } from '../core/baseline';

let counter = 0;
const tmpName = (file: string) => `${file}.${process.pid}.${Date.now()}.${counter++}.tmp`;

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows can briefly lock files (antivirus, indexers): retry a few times.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

/** Write a file atomically: temp file in the same directory, then rename over the target. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    await writeFile(tmp, text, 'utf8');
    await renameWithRetry(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Synchronous variant, used from `process.on('exit')`. */
export function writeFileAtomicSync(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
}

/** Read and validate a baseline file. Returns undefined when the file does not exist. */
export async function readBaseline(file: string): Promise<Baseline | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return parseBaseline(text);
}

/** Serialize and atomically write a baseline file. */
export async function writeBaseline(file: string, baseline: Baseline): Promise<void> {
  await writeFileAtomic(file, serializeBaseline(baseline));
}
