/**
 * Post-login redirect target (IRTC R1-06).
 *
 * `next=` comes from the URL, so it is attacker-controlled. Only a same-origin, relative path is
 * accepted; anything else falls back to `/`. A plain "starts with `/` but not `//`" check is not
 * enough: the WHATWG URL parser (used by browsers and the Next.js router) treats `\` like `/` and
 * silently drops tab, CR and LF, so `/\evil.example` and `/\t/evil.example` both resolve to
 * `//evil.example`, an off-site, protocol-relative URL.
 *
 * Rules, applied to the raw value and to its percent-decoded form (so encoded forms such as `%5C`,
 * `%2F` or `%09` cannot be decoded into one of the above later):
 * - must start with exactly one `/`;
 * - no backslash and no ASCII control character anywhere;
 * - no encoded slash or backslash in the path part (the query may carry encoded data);
 * - resolved against a fixed origin it must keep that origin; the normalised
 *   `pathname + search + hash` is what the caller navigates to.
 */
const MAX_LEN = 2048;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/;
const PROBE_ORIGIN = 'https://kora.invalid';

function decodeFully(s: string): string | null {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return null;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > MAX_LEN) return '/';
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  if (FORBIDDEN.test(next)) return '/';
  const path = next.split(/[?#]/, 1)[0]!;
  if (/%(2f|5c)/i.test(path) || /%25/i.test(path)) return '/';
  const decoded = decodeFully(next);
  if (decoded === null || FORBIDDEN.test(decoded)) return '/';
  const decodedPath = decodeFully(path);
  if (decodedPath === null || decodedPath.startsWith('//')) return '/';
  let url: URL;
  try {
    url = new URL(next, PROBE_ORIGIN);
  } catch {
    return '/';
  }
  if (url.origin !== PROBE_ORIGIN) return '/';
  const out = `${url.pathname}${url.search}${url.hash}`;
  return out.startsWith('/') && !out.startsWith('//') ? out : '/';
}
