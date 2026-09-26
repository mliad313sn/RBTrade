import { describe, expect, it } from 'vitest';

import { hashRecoveryCode, newRecoveryCode, normaliseRecoveryCode } from './recovery-codes';

describe('recovery codes (B-902)', () => {
  it('are 10 base32 characters shown as two groups, and unique', () => {
    const codes = new Set(Array.from({ length: 500 }, newRecoveryCode));
    expect(codes.size).toBe(500);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });
  it('hash is per user and ignores case and the dash', () => {
    const c = 'ABCDE-23456';
    expect(normaliseRecoveryCode(' abcde23456 ')).toBe('ABCDE23456');
    expect(hashRecoveryCode('u1', c)).toBe(hashRecoveryCode('u1', 'abcde23456'));
    expect(hashRecoveryCode('u1', c)).not.toBe(hashRecoveryCode('u2', c));
    expect(hashRecoveryCode('u1', c)).toMatch(/^[0-9a-f]{64}$/);
  });
});
