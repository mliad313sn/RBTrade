import { createHash } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';
import { decodeJwt } from 'jose';

import { ACCESS_COOKIE } from '../auth/cookies';
import { clientIp } from './request';

/**
 * IRTC R1-05: sign-in rate limits keyed per client IP *and* account.
 *
 * - `account` throttler (opt-in per route): KORA_AUTH_RATE_LIMIT per minute (default 20) per
 *   (IP, account). One client hammering one account cannot block anyone else's sign-in, even when
 *   they share an address (NAT, corporate proxy).
 * - `default` throttler on the same routes: KORA_AUTH_IP_RATE_LIMIT per minute per IP (default
 *   5 x the per-account limit), which bounds spraying many accounts from one address.
 * The account is the e-mail in the body (sign-up, password step), else the subject of the MFA token
 * or session token. The token is decoded *without* verification: it only picks a bucket, and a
 * forged value only moves the caller to another bucket under the same per-IP ceiling.
 */
export const authLimit = (): number => Number(process.env.KORA_AUTH_RATE_LIMIT ?? 20) || 20;
export const authIpLimit = (): number => Number(process.env.KORA_AUTH_IP_RATE_LIMIT ?? 0) || 5 * authLimit();

function subjectOf(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 8192) return null;
  try {
    const sub = decodeJwt(token).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

export function accountKey(req: { body?: unknown; headers?: Record<string, unknown>; cookies?: Record<string, unknown> }): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.email === 'string') return `e:${body.email.trim().toLowerCase()}`;
  const mfaSub = subjectOf(body.mfaToken);
  if (mfaSub) return `s:${mfaSub}`;
  const auth = req.headers?.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const sub = subjectOf(bearer ?? req.cookies?.[ACCESS_COOKIE]);
  return sub ? `s:${sub}` : 'anonymous';
}

export const ipAccountTracker: ThrottlerGetTrackerFunction = (req) => {
  const key = createHash('sha256').update(accountKey(req)).digest('hex').slice(0, 32);
  return `${clientIp(req as never)}|${key}`;
};

/** The `account` throttler applies only to routes that opt in with `@Throttle({ account: … })`. */
export const skipUnlessAccountThrottled = (ctx: ExecutionContext): boolean =>
  Reflect.getMetadata('THROTTLER:LIMITaccount', ctx.getHandler()) === undefined;

/** The `long` throttler (per IP, long windows) applies only to routes that opt in. */
export const skipUnlessLongThrottled = (ctx: ExecutionContext): boolean =>
  Reflect.getMetadata('THROTTLER:LIMITlong', ctx.getHandler()) === undefined;

/**
 * IRTC R1-11: new accounts per client IP per hour (default 10), and appropriateness attempts per
 * client IP per day across all accounts (default 10), so a sybil cannot walk the answer key by
 * opening many accounts (the cool-down applies per account).
 */
export const signupLimitPerHour = (): number => Number(process.env.KORA_SIGNUP_RATE_LIMIT_PER_HOUR ?? 10) || 10;
export const appropriatenessIpLimitPerDay = (): number => Number(process.env.KORA_APPROPRIATENESS_IP_LIMIT_PER_DAY ?? 10) || 10;

/** Decorator options for sign-in routes (read per request; tests change the env at runtime). */
export const authThrottle = () => ({
  default: { limit: () => authIpLimit(), ttl: 60_000 },
  account: { limit: () => authLimit(), ttl: 60_000 },
});
