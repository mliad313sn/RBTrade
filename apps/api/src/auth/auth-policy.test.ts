import { describe, expect, it } from 'vitest';

import { AUTH_POLICY, backoffKeys, backoffSeconds, ipHash, mfaLockMinutes } from './auth-policy';

describe('auth brute-force policy (IRTC R1-01, R1-04)', () => {
  it('password back-off: free attempts, then doubling, capped', () => {
    const r = AUTH_POLICY.pair;
    expect(backoffSeconds(0, r)).toBe(0);
    expect(backoffSeconds(4, r)).toBe(0);
    expect(backoffSeconds(5, r)).toBe(30);
    expect(backoffSeconds(6, r)).toBe(60);
    expect(backoffSeconds(9, r)).toBe(480);
    expect(backoffSeconds(10, r)).toBe(900);
    expect(backoffSeconds(1000, r)).toBe(900);
    expect(backoffSeconds(Number.NaN, r)).toBe(0);
    expect(backoffSeconds(20, AUTH_POLICY.account)).toBe(60);
    expect(backoffSeconds(19, AUTH_POLICY.account)).toBe(0);
  });

  it('second-factor lock doubles per renewal up to 24 h', () => {
    expect(mfaLockMinutes(0)).toBe(15);
    expect(mfaLockMinutes(1)).toBe(30);
    expect(mfaLockMinutes(6)).toBe(960);
    expect(mfaLockMinutes(7)).toBe(1440);
    expect(mfaLockMinutes(99)).toBe(1440);
    expect(mfaLockMinutes(-3)).toBe(15);
  });

  it('keys depend on the e-mail (case-insensitive) and IP only, never on account existence', () => {
    const a = backoffKeys(' Alice@Example.com ', '192.0.2.1');
    const b = backoffKeys('alice@example.com', '192.0.2.1');
    const c = backoffKeys('alice@example.com', '192.0.2.2');
    expect(a).toEqual(b);
    expect(c.account).toBe(a.account);
    expect(c.pair).not.toBe(a.pair);
    expect(a.pair).toMatch(/^[0-9a-f]{64}$/);
    expect(ipHash('192.0.2.1')).not.toBe(ipHash('192.0.2.2'));
  });
});
