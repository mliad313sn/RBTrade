import { createHash } from 'node:crypto';

/**
 * Brute-force policy for the dev IdP sign-in (IRTC R1-01, R1-04, R1-07).
 * Decided by the Product Owner under delegated Sponsor authority (docs/open-questions.md OQ-R1-1);
 * the conservative option was taken at each choice.
 *
 * Second factor (TOTP code, recovery code, step-up code): consecutive failures are counted on the
 * account, separately from the password. Only a successful second factor resets the count; a
 * correct password never does. At `maxFailures` the second factor locks for `baseLockMinutes`,
 * doubling on every renewal up to `maxLockMinutes`. While the count stays at or above the
 * threshold, any further failure after a lock expires renews it at once. A lock reached through
 * step-up (a signed-in session) also ends every session of the user.
 *
 * Password: no hard lock (anyone could lock a known account, and a distinct answer revealed which
 * accounts exist). Progressive back-off instead, keyed on the e-mail string, never on whether the
 * account exists, so an unknown e-mail behaves exactly like a real one:
 * - per (e-mail, client IP): `pair.freeFailures` free, then `baseSeconds × 2^(n − free)` capped;
 * - per e-mail over all IPs: `account.freeFailures` free, then the same doubling capped, applied
 *   only to IPs the owner has not completed a sign-in from in the last `knownIpDays` days.
 * Attempts refused during a back-off are not counted, so renewals are capped by the attacker's own
 * real failures, and counters decay after `windowHours` without a failure.
 */
export const AUTH_POLICY = {
  mfa: { maxFailures: 5, baseLockMinutes: 15, maxLockMinutes: 24 * 60 },
  pair: { freeFailures: 5, baseSeconds: 30, maxSeconds: 15 * 60 },
  account: { freeFailures: 20, baseSeconds: 60, maxSeconds: 15 * 60 },
  windowHours: 24,
  knownIpDays: 90,
} as const;

/** Back-off after `failures` counted failures (0 = none yet). */
export function backoffSeconds(failures: number, rule: { freeFailures: number; baseSeconds: number; maxSeconds: number }): number {
  if (!Number.isInteger(failures) || failures < rule.freeFailures) return 0;
  const exp = Math.min(failures - rule.freeFailures, 30);
  return Math.min(rule.baseSeconds * 2 ** exp, rule.maxSeconds);
}

/** Length of the n-th consecutive second-factor lock (0-based renewal count). */
export function mfaLockMinutes(lockCount: number): number {
  const exp = Math.min(Math.max(0, Math.floor(lockCount)), 30);
  return Math.min(AUTH_POLICY.mfa.baseLockMinutes * 2 ** exp, AUTH_POLICY.mfa.maxLockMinutes);
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const backoffKeys = (email: string, ip: string) => ({
  pair: sha(`kora-login-pair\u0000${normaliseEmail(email)}\u0000${ip}`),
  account: sha(`kora-login-account\u0000${normaliseEmail(email)}`),
});

export const ipHash = (ip: string) => sha(`kora-known-ip\u0000${ip}`);
