/** Small, dependency-free helpers shared by the core modules. */

/** 32-bit FNV-1a hash as 8 hex chars. Stable across runtimes; not cryptographic. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const hasOwn = Object.prototype.hasOwnProperty;

/** Own property lookup that never falls through to the prototype chain. */
export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return hasOwn.call(map, key) ? map[key] : undefined;
}

/** A prototype-less record, safe for arbitrary keys such as `__proto__`. */
export function createMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Own enumerable keys sorted by UTF-16 code unit order (locale independent). */
export function sortedKeys(obj: object): string[] {
  return Object.keys(obj).sort(compareStrings);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON.stringify with object keys sorted, for deterministic files and hashes. */
export function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortDeep(value), null, space);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = createMap<unknown>();
    for (const k of sortedKeys(value)) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortDeep(v);
    }
    return out;
  }
  return value;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Append a property segment to a JSONPath-like path (`$.a`, `$["content-type"]`). */
export function joinPath(parent: string, key: string): string {
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/** True when `path` equals `prefix` or is nested beneath it. */
export function isWithinPath(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (!path.startsWith(prefix)) return false;
  const next = path.charAt(prefix.length);
  return next === '.' || next === '[';
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a path pattern: exact path (and descendants), `*` wildcards, or a RegExp. */
export function compilePathPattern(pattern: string | RegExp): (path: string) => boolean {
  if (pattern instanceof RegExp) return (p) => pattern.test(p);
  if (!pattern.includes('*')) return (p) => isWithinPath(p, pattern);
  const re = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}(?:$|[.[])`);
  return (p) => re.test(p);
}

const UNITS: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 };

/** Parse `250`, `"250ms"`, `"30s"`, `"10m"`, `"1h"`, `"7d"` into milliseconds. */
export function parseDuration(value: number | string): number {
  if (typeof value === 'number') return value;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(value);
  if (!m) throw new TypeError(`Invalid duration: ${JSON.stringify(value)}`);
  return Number(m[1]) * UNITS[(m[2] ?? 'ms').toLowerCase()];
}

/** `"get /users/:id"` -> `"GetUsersId"`. Keeps digits, drops everything else. */
export function pascalCase(input: string): string {
  const words = input
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/** Sorted union of two sorted string sets. */
export function unionSorted<T extends string>(a: readonly T[], b: readonly T[]): T[] {
  if (a === b) return a.slice();
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) out.push(a[i++]);
    else if (i >= a.length || b[j] < a[i]) out.push(b[j++]);
    else {
      out.push(a[i]);
      i++;
      j++;
    }
  }
  return out;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Truncate a string to `max` characters with an ellipsis. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
