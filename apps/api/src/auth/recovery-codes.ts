import { createHash, randomBytes } from 'node:crypto';

/** B-902: how many one-time recovery codes a user holds. */
export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A fresh code: 10 base32 characters (50 bits), shown as XXXXX-XXXXX. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function normaliseRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/-/g, '');
}

/**
 * Stored form: SHA-256 over the user id and the normalised code. The codes carry 50 random bits and
 * are single-use behind the login lockout, so a fast hash is enough (no offline dictionary to fear).
 */
export function hashRecoveryCode(userId: string, code: string): string {
  return createHash('sha256').update(`kora-recovery:${userId}:${normaliseRecoveryCode(code)}`).digest('hex');
}
