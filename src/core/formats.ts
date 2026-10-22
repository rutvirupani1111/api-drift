import type { StringFormat } from './shape';

/**
 * String format detection. Checks run most-specific first; the first match wins.
 * Patterns are exported so generated Zod schemas validate exactly what was detected.
 */
export const FORMAT_PATTERNS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time':
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/i,
  date: /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/,
  time: /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/i,
  email: /^[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?(?:\.[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?)*\.[A-Za-z]{2,}$/,
  jwt: /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/,
  uri: /^[a-z][a-z\d+.-]*:\/\/[^\s/?#]+[^\s]*$/i,
  ipv4: /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/,
  'hex-color': /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i,
  semver:
    /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i,
  'numeric-string': /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i,
  phone: /^\+?[\d\s().-]{7,24}$/,
} as const;

const HEX_GROUP = /^[\da-f]{1,4}$/i;

/** Validates IPv6 text form, including `::` compression. */
export function isIPv6(s: string): boolean {
  if (s.length < 2 || s.length > 45 || !s.includes(':')) return false;
  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = head.concat(tail);
  if (!all.every((g) => HEX_GROUP.test(g))) return false;
  return halves.length === 2 ? all.length < 8 : all.length === 8;
}

function digitCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) n++;
  }
  return n;
}

function isPhone(s: string): boolean {
  if (!FORMAT_PATTERNS.phone.test(s)) return false;
  const digits = digitCount(s);
  return digits >= 7 && digits <= 15 && (s.charAt(0) === '+' || /[\s().-]/.test(s));
}

const B64_STD = /^[A-Za-z\d+/]+={0,2}$/;
const B64_URL = /^[\w-]+$/;

/** Long base64 / base64url blobs (40+ chars, mixed case and digits). */
export function isBase64(s: string): boolean {
  if (s.length < 40) return false;
  const std = B64_STD.test(s);
  if (std ? s.length % 4 !== 0 : !B64_URL.test(s)) return false;
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s);
}

/** Detect the format of a string value. Returns `plain` when nothing matches. */
export function detectFormat(s: string): StringFormat {
  if (s.length === 0) return 'empty';
  const P = FORMAT_PATTERNS;
  if (s.length <= 64) {
    if (P.uuid.test(s)) return 'uuid';
    if (P['date-time'].test(s)) return 'date-time';
    if (P.date.test(s)) return 'date';
    if (P.time.test(s)) return 'time';
  }
  if (s.length <= 254 && s.includes('@') && P.email.test(s)) return 'email';
  if (s.charCodeAt(0) === 101 /* e */ && P.jwt.test(s)) return 'jwt';
  if (s.includes('://') && P.uri.test(s)) return 'uri';
  if (s.length <= 45) {
    if (P.ipv4.test(s)) return 'ipv4';
    if (isIPv6(s)) return 'ipv6';
    if (P['hex-color'].test(s)) return 'hex-color';
    if (P.semver.test(s)) return 'semver';
  }
  if (P['numeric-string'].test(s)) return 'numeric-string';
  if (s.length <= 24 && isPhone(s)) return 'phone';
  if (isBase64(s)) return 'base64';
  return 'plain';
}

const CODE = /^[\w.:/+-]+$/;

/**
 * True when a string looks like a code (`active`, `IN_PROGRESS`, `en-US`,
 * `application/json`) rather than free text, a name or an identifier.
 * Only code-like values are ever captured as enum candidates.
 */
export function isCodeLike(s: string): boolean {
  if (s.length === 0 || s.length > 40 || !CODE.test(s)) return false;
  // Identifiers mix letters with several digits (cus_N3x8aB2k, a1b2c3d4).
  if (s.length >= 8 && digitCount(s) >= 3 && /[A-Za-z]/.test(s)) return false;
  return true;
}
