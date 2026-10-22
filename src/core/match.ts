/**
 * URL matchers used by `include` / `exclude`:
 * - `'api.stripe.com'`  host (or any subdomain of it); `'*.example.com'` subdomains only
 * - `'api.example.com/v2'`  host + path prefix
 * - `/\.githubusercontent\.com$/`  tested against the host, then the full URL
 * - `(url, method) => boolean`  anything else
 */
export type Matcher = string | RegExp | ((url: URL, method: string) => boolean);

function matchOne(m: Matcher, url: URL, method: string): boolean {
  if (typeof m === 'function') return m(url, method);
  const hostname = url.hostname.toLowerCase();
  if (m instanceof RegExp) {
    m.lastIndex = 0;
    if (m.test(hostname)) return true;
    m.lastIndex = 0;
    return m.test(url.href);
  }
  const pattern = m.toLowerCase().replace(/^[a-z]+:\/\//, '');
  if (pattern.includes('/')) return `${url.host}${url.pathname}`.toLowerCase().startsWith(pattern);
  if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1));
  const host = url.host.toLowerCase();
  return hostname === pattern || host === pattern || hostname.endsWith(`.${pattern}`);
}

const toList = (m: Matcher | readonly Matcher[] | undefined): readonly Matcher[] =>
  m === undefined ? [] : Array.isArray(m) ? m : [m as Matcher];

/** Compile include/exclude lists into one predicate. Empty include = everything. */
export function compileMatchers(
  include?: Matcher | readonly Matcher[],
  exclude?: Matcher | readonly Matcher[],
): (url: URL, method: string) => boolean {
  const inc = toList(include);
  const exc = toList(exclude);
  return (url, method) =>
    (inc.length === 0 || inc.some((m) => matchOne(m, url, method))) && !exc.some((m) => matchOne(m, url, method));
}
