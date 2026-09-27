import { describe, expect, it } from 'vitest';

import { safeNext } from './safe-next';

/**
 * IRTC R1-06: the post-login `next=` target must stay a same-origin relative path. Browsers and the
 * WHATWG URL parser treat `\` as `/` and drop tabs/newlines, so `/\evil.example` becomes
 * `//evil.example` (protocol-relative, off-site) after a naive "starts with / but not //" check.
 */
describe('safeNext (IRTC R1-06)', () => {
  it('keeps plain same-origin paths, their query and hash', () => {
    expect(safeNext('/terminal')).toBe('/terminal');
    expect(safeNext('/terminal?symbol=EURUSD&tf=1m#ticket')).toBe('/terminal?symbol=EURUSD&tf=1m#ticket');
    expect(safeNext('/novice/home')).toBe('/novice/home');
    // an encoded slash inside the query is data, not a path separator
    expect(safeNext('/terminal?symbol=EUR%2FUSD')).toBe('/terminal?symbol=EUR%2FUSD');
  });

  it('falls back to / for empty or non-relative values', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('terminal')).toBe('/');
    expect(safeNext('https://evil.example/x')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
    expect(safeNext('/' + 'a'.repeat(2100))).toBe('/');
  });

  it('refuses protocol-relative and backslash tricks (the R1-06 reproduction)', () => {
    expect(safeNext('//evil.example/phish')).toBe('/');
    expect(safeNext('/\\evil.example/phish')).toBe('/');
    expect(safeNext('\\\\evil.example')).toBe('/');
    expect(safeNext('/\\/evil.example')).toBe('/');
    expect(safeNext('/./\\evil.example')).toBe('/');
  });

  it('refuses control characters that the URL parser strips (tab, CR, LF, NUL)', () => {
    expect(safeNext('/\t/evil.example')).toBe('/');
    expect(safeNext('/\n/evil.example')).toBe('/');
    expect(safeNext('/\r/evil.example')).toBe('/');
    expect(safeNext('/\u0000/evil.example')).toBe('/');
    expect(safeNext('/terminal\u007f')).toBe('/');
  });

  it('refuses encoded slashes, backslashes and control characters in the path', () => {
    expect(safeNext('/%2Fevil.example')).toBe('/');
    expect(safeNext('/%2fevil.example')).toBe('/');
    expect(safeNext('/%5Cevil.example')).toBe('/');
    expect(safeNext('/%5cevil.example')).toBe('/');
    expect(safeNext('/%09/evil.example')).toBe('/');
    expect(safeNext('/%252F%252Fevil.example')).toBe('/');
    expect(safeNext('/%E0%A4%A')).toBe('/'); // malformed escape
  });

  it('never returns a value that resolves off-origin', () => {
    const origin = 'https://kora.example';
    const probes = ['/\\evil', '//evil', '/\t/evil', '/%5Cevil', '/%2F/evil', '/..//evil', '/.//evil', '/a/../\\evil', '\\/evil'];
    for (const p of probes) {
      const out = safeNext(p);
      expect(new URL(out, origin).origin, p).toBe(origin);
      expect(out.startsWith('//'), p).toBe(false);
    }
  });
});
