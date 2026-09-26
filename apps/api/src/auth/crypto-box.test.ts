import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CryptoBox } from './crypto-box';

describe('CryptoBox', () => {
  it('round-trips and binds AAD', () => {
    const box = CryptoBox.ephemeral();
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'user-1');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(sealed, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => box.open(sealed, 'user-2')).toThrow();
  });
  it('detects tampering and wrong keys', () => {
    const box = new CryptoBox(randomBytes(32).toString('base64'));
    const sealed = box.seal('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => CryptoBox.ephemeral().open(sealed)).toThrow();
    expect(() => box.open('v2.a.b.c')).toThrow(/Unsupported/);
  });
  it('validates key length', () => {
    expect(() => new CryptoBox(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
