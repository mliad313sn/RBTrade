import { describe, expect, it } from 'vitest';

import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUrl, totp, verifyTotp } from './totp';

// RFC 6238 Appendix B test vectors (SHA-1, 8 digits, secret "12345678901234567890").
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it.each(VECTORS)('matches RFC 6238 vector at T=%i', (t, expected) => {
    expect(totp(RFC_SECRET, t * 1000, { digits: 8 })).toBe(expected);
  });
  it('matches RFC 4226 HOTP vectors', () => {
    expect(hotp(RFC_SECRET, 0n)).toBe('755224');
    expect(hotp(RFC_SECRET, 9n)).toBe('520489');
  });
  it('round-trips base32', () => {
    const buf = Buffer.from('hello KORA!');
    expect(base32Decode(base32Encode(buf)).toString()).toBe('hello KORA!');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    expect(() => base32Decode('0189')).toThrow();
  });
  it('verifies within the window and returns the step', () => {
    const secret = base32Decode(generateTotpSecret());
    const now = 1_700_000_000_000;
    const code = totp(secret, now - 30_000);
    expect(verifyTotp(secret, code, now)).toBe(BigInt(Math.floor(now / 30000)) - 1n);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, '12ab56', now)).toBeNull();
    expect(verifyTotp(secret, '1234567', now)).toBeNull();
    expect(verifyTotp(secret, totp(secret, 0), 0)).toBe(0n);
  });
  it('builds an otpauth uri', () => {
    const u = otpauthUrl('ABC', 'a@b.co');
    expect(u).toMatch(/^otpauth:\/\/totp\/KORA%3Aa%40b\.co\?secret=ABC&issuer=KORA/);
  });
});
