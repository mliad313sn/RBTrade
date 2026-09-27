import { EventEmitter } from 'node:events';

import { Injectable } from '@nestjs/common';

import { DbService, type Queryable } from '../db/db.service';
import type { Principal } from './principal';

/** Local cache TTL: another api replica sees a revocation within this time (same replica: at once). */
const CACHE_MS = 2_000;

/**
 * IRTC R1-03: emitted on this replica whenever sessions end, so long-lived connections (the
 * WebSocket gateway) can drop them at once; the gateway relays it to other replicas over Redis.
 * `tokenId`: one token was revoked (logout). `validAfterSec`: every token of the user issued
 * before this epoch second is refused (role change, MFA reset, lock, disable).
 */
export interface SessionRevocation {
  userId: string;
  tokenId?: string;
  validAfterSec?: number;
}

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
  /** IRTC R1-03: `revoked` events ({@link SessionRevocation}). */
  readonly events = new EventEmitter();

  constructor(private readonly db: DbService) {
    this.events.setMaxListeners(50);
  }

  /** `fresh` skips the local cache (the WebSocket gateway re-checks on every subscribe). */
  async isActive(p: Principal, opts: { fresh?: boolean } = {}): Promise<boolean> {
    const key = `${p.sub}:${p.tokenId ?? ''}`;
    let s = opts.fresh ? undefined : this.cache.get(key);
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
    return SessionsService.judge(p, s);
  }

  private static judge(p: Principal, s: Pick<SessionState, 'revoked' | 'validAfterSec' | 'disabled'>): boolean {
    if (s.revoked || s.disabled) return false;
    if (s.validAfterSec !== null && p.issuedAt !== undefined && p.issuedAt < s.validAfterSec) return false;
    return true;
  }

  /**
   * IRTC R1-03: batch check for many open connections (the gateway sweep): two queries whatever the
   * number of principals. Returns the principals whose session is no longer active.
   */
  async inactive<T extends Principal>(principals: T[]): Promise<T[]> {
    if (principals.length === 0) return [];
    const subs = [...new Set(principals.map((p) => p.sub))];
    const jtis = [...new Set(principals.map((p) => p.tokenId).filter((j): j is string => !!j))];
    const users = await this.db.pool.query<{ id: string; valid_after: number | null; disabled: boolean }>(
      `SELECT id::text AS id, ceil(extract(epoch FROM sessions_valid_after))::bigint::float8 AS valid_after, status = 'disabled' AS disabled
         FROM users WHERE id = ANY($1::uuid[])`,
      [subs],
    );
    const revoked = jtis.length
      ? new Set((await this.db.pool.query<{ jti: string }>('SELECT jti FROM revoked_tokens WHERE jti = ANY($1::text[])', [jtis])).rows.map((r) => r.jti))
      : new Set<string>();
    const byId = new Map(users.rows.map((u) => [u.id, u]));
    return principals.filter((p) => {
      const u = byId.get(p.sub);
      if (!u) return true;
      return !SessionsService.judge(p, { revoked: !!p.tokenId && revoked.has(p.tokenId), validAfterSec: u.valid_after, disabled: u.disabled });
    });
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
    this.emit({ userId: p.sub, tokenId: p.tokenId });
  }

  /**
   * Every token of the user issued up to now is refused (role change, MFA reset, disable). `iat`
   * has one-second resolution, so the whole current second is refused (a sign-in in that same second
   * must be repeated). Uses the application clock so it matches the `iat` the token service writes.
   */
  async invalidateAll(userId: string, c: Queryable = this.db.pool): Promise<void> {
    const at = new Date(Date.now());
    await c.query('UPDATE users SET sessions_valid_after = $2, updated_at = now() WHERE id = $1', [userId, at]);
    this.forget(userId);
    this.emit({ userId, validAfterSec: Math.ceil(at.getTime() / 1000) });
  }

  private emit(r: SessionRevocation): void {
    try {
      this.events.emit('revoked', r);
    } catch {
      // a listener failure must never fail the revocation itself
    }
  }

  forget(userId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${userId}:`)) this.cache.delete(k);
  }
}
