import { Injectable } from '@nestjs/common';

import { DbService, type Queryable } from '../db/db.service';
import type { Principal } from './principal';

/** Local cache TTL: another api replica sees a revocation within this time (same replica: at once). */
const CACHE_MS = 2_000;

interface SessionState {
  revoked: boolean;
  validAfterSec: number | null;
  disabled: boolean;
  at: number;
}

/**
 * Server-side session control (goal 10, S9; B-002 part). JWT access tokens stay stateless for the
 * signature, but every request also checks, in Postgres (so it keeps working when Redis is down,
 * which the REST kill switch relies on):
 * - the token id was not revoked by a logout;
 * - the token was issued after the user's `sessions_valid_after` (set by role changes, MFA resets
 *   and disabling the user, so a removed role or a reset authenticator cannot keep a live session);
 * - the user is not disabled.
 * Keycloak deployments add refresh-token revocation on top (B-001).
 */
@Injectable()
export class SessionsService {
  private readonly cache = new Map<string, SessionState>();

  constructor(private readonly db: DbService) {}

  async isActive(p: Principal): Promise<boolean> {
    const key = `${p.sub}:${p.tokenId ?? ''}`;
    let s = this.cache.get(key);
    if (!s || Date.now() - s.at > CACHE_MS) {
      const { rows } = await this.db.pool.query<{ revoked: boolean; valid_after: number | null; disabled: boolean | null }>(
        `SELECT EXISTS (SELECT 1 FROM revoked_tokens WHERE jti = $2) AS revoked,
                ceil(extract(epoch FROM u.sessions_valid_after))::bigint::float8 AS valid_after,
                u.status = 'disabled' AS disabled
           FROM (SELECT 1) one LEFT JOIN users u ON u.id = $1::uuid`,
        [p.sub, p.tokenId ?? ''],
      );
      const r = rows[0];
      s = { revoked: !!r?.revoked, validAfterSec: r?.valid_after ?? null, disabled: !!r?.disabled, at: Date.now() };
      if (this.cache.size > 50_000) this.cache.clear();
      this.cache.set(key, s);
    }
    if (s.revoked || s.disabled) return false;
    if (s.validAfterSec !== null && p.issuedAt !== undefined && p.issuedAt < s.validAfterSec) return false;
    return true;
  }

  /** Logout: the presented token id is refused until it would have expired anyway. */
  async revoke(p: Principal, reason: 'logout' | 'admin' = 'logout'): Promise<void> {
    if (!p.tokenId) return;
    const expires = new Date(((p.expiresAt ?? Math.floor(Date.now() / 1000) + 86_400) as number) * 1000);
    await this.db.pool.query(
      `INSERT INTO revoked_tokens (jti, user_id, reason, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (jti) DO NOTHING`,
      [p.tokenId, p.sub, reason, expires],
    );
    await this.db.pool.query('DELETE FROM revoked_tokens WHERE expires_at < now()');
    this.forget(p.sub);
  }

  /**
   * Every token of the user issued up to now is refused (role change, MFA reset, disable). `iat`
   * has one-second resolution, so the whole current second is refused (a sign-in in that same second
   * must be repeated). Uses the application clock so it matches the `iat` the token service writes.
   */
  async invalidateAll(userId: string, c: Queryable = this.db.pool): Promise<void> {
    await c.query('UPDATE users SET sessions_valid_after = $2, updated_at = now() WHERE id = $1', [userId, new Date(Date.now())]);
    this.forget(userId);
  }

  private forget(userId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${userId}:`)) this.cache.delete(k);
  }
}
