import { FORMAT_PATTERNS } from './formats';

/**
 * Endpoint keys group traffic into contracts:
 *
 *     METHOD host /templated/path status-class
 *     GET api.github.com /repos/:id/pulls 2xx
 *
 * Path segments that look like identifiers become `:id`.
 */

export interface EndpointInfo {
  method?: string;
  url: string | URL;
  status?: number;
}

export interface KeyOptions {
  /** Query parameters to keep in the key (values that look like ids are templated). */
  keepQuery?: readonly string[];
}

const VERSION_SEGMENT = /^v\d+(?:[a-z]+\d*)?(?:\.\d+)*$/i;
const HEX_ID = /^[\da-f]{8,}$/i;
const DIGITS = /^\d+$/;
const NUMERIC_WITH_SEPARATORS = /^\d[\d.\-_:]*$/;
const LOOSE_EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * True when a path segment is data rather than a route name: integers, UUIDs,
 * ObjectIds and other hex >= 8, emails, dates/versions, and slugs with digits
 * (`iphone-15-pro`, `cus_N3x8aB2k`). API versions such as `v1`/`v2beta1` are kept.
 */
export function isIdSegment(segment: string): boolean {
  const s = safeDecode(segment);
  if (s.length === 0) return false;
  if (DIGITS.test(s)) return true;
  if (FORMAT_PATTERNS.uuid.test(s)) return true;
  if (HEX_ID.test(s) && /\d/.test(s)) return true;
  if (s.includes('@') && LOOSE_EMAIL.test(s)) return true;
  if (/^\d+\.\d+$/.test(s)) return false; // "1.0", "2.0": API versions
  if (NUMERIC_WITH_SEPARATORS.test(s)) return true;
  if (/\d/.test(s) && /[a-z]/i.test(s)) {
    if (VERSION_SEGMENT.test(s)) return false;
    if (/[-_.~]/.test(s)) return true;
    if (s.length >= 8) return true;
  }
  return false;
}

/**
 * True when an object key is data (an id, email, date or version) rather than
 * a field name. Values under such keys are merged into one `additional` shape,
 * so dictionaries keyed by ids neither leak the ids nor drift on every new key.
 */
export function isDynamicKey(key: string): boolean {
  if (key.length === 0) return false;
  if (DIGITS.test(key)) return true;
  if (FORMAT_PATTERNS.uuid.test(key)) return true;
  if (HEX_ID.test(key) && /\d/.test(key)) return true;
  if (key.includes('@') && LOOSE_EMAIL.test(key)) return true;
  if (FORMAT_PATTERNS.semver.test(key) || FORMAT_PATTERNS.date.test(key)) return true;
  if (FORMAT_PATTERNS['date-time'].test(key)) return true;
  // Long random identifiers: 16+ alphanumerics mixing letters with 3+ digits.
  return key.length >= 16 && /^[A-Za-z\d]+$/.test(key) && /\d.*\d.*\d/.test(key) && /[a-z]/i.test(key);
}

/** Replace id-like path segments with `:id`, normalise slashes. */
export function templatePath(pathname: string): string {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return '/';
  return `/${parts.map((p) => (isIdSegment(p) ? ':id' : p)).join('/')}`;
}

/** `200` -> `2xx`. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function toURL(url: string | URL): URL {
  if (url instanceof URL) return url;
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    return new URL(url, base);
  } catch {
    return new URL(url, 'http://localhost');
  }
}

/** Build the endpoint key for a request. */
export function endpointKey(info: EndpointInfo, options: KeyOptions = {}): string {
  const u = toURL(info.url);
  const method = (info.method ?? 'GET').toUpperCase();
  let path = templatePath(u.pathname);
  if (options.keepQuery && options.keepQuery.length > 0) {
    const kept: string[] = [];
    for (const name of [...options.keepQuery].sort()) {
      for (const v of u.searchParams.getAll(name)) {
        kept.push(`${name}=${isIdSegment(v) ? ':id' : v}`);
      }
    }
    if (kept.length > 0) path += `?${kept.join('&')}`;
  }
  const parts = [method, u.host.toLowerCase(), path];
  if (info.status !== undefined) parts.push(statusClass(info.status));
  return parts.join(' ');
}

export interface ParsedKey {
  method: string;
  host: string;
  path: string;
  status?: string;
}

/** Parse a key produced by `endpointKey`. Returns undefined for custom keys. */
export function parseEndpointKey(key: string): ParsedKey | undefined {
  const m = /^([A-Z]+) (\S+) (\/\S*)(?: ([1-5]xx))?$/.exec(key);
  if (!m) return undefined;
  return { method: m[1], host: m[2], path: m[3], status: m[4] };
}

/** The key without its status class: `GET host /path`. */
export function routeOf(key: string): string {
  const p = parseEndpointKey(key);
  return p ? `${p.method} ${p.host} ${p.path}` : key;
}

/** A URL without query string or fragment (query strings can carry secrets). */
export function redactUrl(url: string | URL): string {
  try {
    const u = toURL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}
