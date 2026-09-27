import { Injectable } from '@nestjs/common';
import { isRole, type Role } from '@kora/domain';

import { DbService, type Queryable } from '../db/db.service';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: 'active' | 'disabled';
  failed_logins: number;
  /** Second factor locked until (IRTC R1-01). */
  locked_until: Date | null;
  mfa_failed_count: number;
  mfa_lock_count: number;
  created_at: Date;
}

export interface MfaRow {
  user_id: string;
  totp_secret_enc: string;
  enabled_at: Date | null;
  last_used_step: string | null;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly db: DbService) {}

  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    return rows[0] ?? null;
  }

  async findById(id: string, c: Queryable = this.db.pool): Promise<UserRow | null> {
    const { rows } = await c.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async roles(userId: string, c: Queryable = this.db.pool): Promise<Role[]> {
    const { rows } = await c.query<{ role: string }>('SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role', [
      userId,
    ]);
    return rows.map((r) => r.role).filter(isRole);
  }

  async create(
    c: Queryable,
    u: { email: string; displayName: string; passwordHash: string | null; roles: Role[]; id?: string; provider?: 'dev' | 'keycloak' },
  ): Promise<UserRow> {
    const { rows } = await c.query<UserRow>(
      `INSERT INTO users (id, email, display_name, password_hash, identity_provider)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5) RETURNING *`,
      [u.id ?? null, u.email, u.displayName, u.passwordHash, u.provider ?? 'dev'],
    );
    const user = rows[0]!;
    await this.setRoles(c, user.id, u.roles, null);
    await c.query('INSERT INTO user_preferences (user_id, view_mode) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      user.id,
      u.roles.every((r) => r === 'novice') ? 'novice' : 'pro',
    ]);
    return user;
  }

  async setRoles(c: Queryable, userId: string, roles: Role[], grantedBy: string | null): Promise<void> {
    await c.query('DELETE FROM user_roles WHERE user_id = $1 AND NOT (role = ANY($2::text[]))', [userId, roles]);
    for (const role of roles) {
      await c.query(
        'INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [userId, role, grantedBy],
      );
    }
  }

  /** Informational wrong-password count (IRTC R1-04: the password step never hard-locks). */
  async recordPasswordFailure(userId: string): Promise<void> {
    await this.db.query('UPDATE users SET failed_logins = failed_logins + 1, updated_at = now() WHERE id = $1', [userId]);
  }

  /**
   * A correct password. IRTC R1-01: this never touches the second-factor count or lock
   * (`mfa_failed_count`, `locked_until`); only a successful second factor resets those.
   */
  async recordPasswordSuccess(userId: string): Promise<void> {
    await this.db.query('UPDATE users SET failed_logins = 0, updated_at = now() WHERE id = $1 AND failed_logins <> 0', [userId]);
  }

  /**
   * One failed second factor (TOTP, recovery code or step-up). At `maxFailures` consecutive failures
   * the second factor locks for `lockMinutes(mfa_lock_count)`; while the count stays at or above the
   * threshold, a failure after the lock expired renews it (doubled). Returns the lock end when this
   * failure (re)locked it. Times use the application clock, the same one the checks use.
   */
  async recordMfaFailure(userId: string, now: Date, maxFailures: number, lockMinutes: (lockCount: number) => number): Promise<Date | null> {
    return this.db.tx(async (c) => {
      const { rows } = await c.query<{ mfa_failed_count: number; mfa_lock_count: number }>(
        'SELECT mfa_failed_count, mfa_lock_count FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const row = rows[0];
      if (!row) return null;
      const failures = row.mfa_failed_count + 1;
      const lock = failures >= maxFailures ? new Date(now.getTime() + lockMinutes(row.mfa_lock_count) * 60_000) : null;
      await c.query(
        `UPDATE users SET mfa_failed_count = $2, mfa_lock_count = mfa_lock_count + $3::int,
           locked_until = COALESCE($4::timestamptz, locked_until), updated_at = now()
         WHERE id = $1`,
        [userId, failures, lock ? 1 : 0, lock],
      );
      return lock;
    });
  }

  /** A successful second factor: the only event that clears the second-factor count and lock. */
  async recordMfaSuccess(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET mfa_failed_count = 0, mfa_lock_count = 0, locked_until = NULL, updated_at = now()
       WHERE id = $1 AND (mfa_failed_count <> 0 OR mfa_lock_count <> 0 OR locked_until IS NOT NULL)`,
      [userId],
    );
  }

  // ---- IRTC R1-04: password back-off, keyed on hashes (never on account existence) ----

  async backoffState(keys: { pair: string; account: string }): Promise<{ pair: Date | null; account: Date | null }> {
    const rows = await this.db.query<{ scope: 'pair' | 'account'; blocked_until: Date | null }>(
      `SELECT scope, blocked_until FROM auth_login_backoff WHERE (scope = 'pair' AND key_hash = $1) OR (scope = 'account' AND key_hash = $2)`,
      [keys.pair, keys.account],
    );
    return {
      pair: rows.find((r) => r.scope === 'pair')?.blocked_until ?? null,
      account: rows.find((r) => r.scope === 'account')?.blocked_until ?? null,
    };
  }

  /**
   * Counts one failure for a key (decaying after `windowHours` without failures) and sets the
   * back-off computed from the new count. Returns the new count.
   */
  async recordBackoffFailure(scope: 'pair' | 'account', keyHash: string, now: Date, windowHours: number, backoff: (failures: number) => number): Promise<number> {
    return this.db.tx(async (c) => {
      const { rows } = await c.query<{ failures: number }>(
        `INSERT INTO auth_login_backoff (scope, key_hash, failures, last_failure_at) VALUES ($1, $2, 0, $3)
         ON CONFLICT (scope, key_hash) DO UPDATE SET
           failures = CASE WHEN auth_login_backoff.last_failure_at < $3::timestamptz - make_interval(hours => $4) THEN 0 ELSE auth_login_backoff.failures END
         RETURNING failures`,
        [scope, keyHash, now, windowHours],
      );
      const failures = rows[0]!.failures + 1;
      const secs = backoff(failures);
      await c.query(
        `UPDATE auth_login_backoff SET failures = $3, last_failure_at = $4, blocked_until = $5 WHERE scope = $1 AND key_hash = $2`,
        [scope, keyHash, failures, now, secs > 0 ? new Date(now.getTime() + secs * 1000) : null],
      );
      return failures;
    });
  }

  async clearBackoff(keys: { pair: string; account: string }): Promise<void> {
    await this.db.query(
      `DELETE FROM auth_login_backoff WHERE (scope = 'pair' AND key_hash = $1) OR (scope = 'account' AND key_hash = $2)`,
      [keys.pair, keys.account],
    );
  }

  /** Housekeeping: drops back-off rows idle for longer than the decay window. */
  async pruneBackoff(now: Date, windowHours: number): Promise<void> {
    await this.db.query(`DELETE FROM auth_login_backoff WHERE last_failure_at < $1::timestamptz - make_interval(hours => $2)`, [now, windowHours]);
  }

  async isKnownIp(userId: string | null, ipHash: string, now: Date, days: number): Promise<boolean> {
    const rows = await this.db.query<{ ok: boolean }>(
      `SELECT true AS ok FROM auth_known_ips WHERE user_id = $1::uuid AND ip_hash = $2 AND last_success_at > $3::timestamptz - make_interval(days => $4)`,
      [userId, ipHash, now, days],
    );
    return rows.length > 0;
  }

  async rememberIp(userId: string, ipHash: string, now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO auth_known_ips (user_id, ip_hash, last_success_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, ip_hash) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`,
      [userId, ipHash, now],
    );
  }

  async mfa(userId: string, c: Queryable = this.db.pool): Promise<MfaRow | null> {
    const { rows } = await c.query<MfaRow>(
      'SELECT user_id, totp_secret_enc, enabled_at, last_used_step::text AS last_used_step FROM user_mfa WHERE user_id = $1',
      [userId],
    );
    return rows[0] ?? null;
  }

  async upsertPendingMfa(userId: string, secretEnc: string): Promise<void> {
    await this.db.query(
      `INSERT INTO user_mfa (user_id, totp_secret_enc) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc, enabled_at = NULL,
         last_used_step = NULL, created_at = now()
       WHERE user_mfa.enabled_at IS NULL`,
      [userId, secretEnc],
    );
  }

  /** Atomically consumes a TOTP step (replay protection). Returns false if the step was already used. */
  async consumeMfaStep(c: Queryable, userId: string, step: bigint): Promise<boolean> {
    const { rowCount } = await c.query(
      `UPDATE user_mfa SET last_used_step = $2, enabled_at = COALESCE(enabled_at, now())
       WHERE user_id = $1 AND (last_used_step IS NULL OR last_used_step < $2)`,
      [userId, step.toString()],
    );
    return rowCount === 1;
  }

  async list(limit = 200): Promise<Array<UserRow & { roles: Role[]; mfa_enabled: boolean }>> {
    const rows = await this.db.query<UserRow & { roles: string[]; mfa_enabled: boolean }>(
      `SELECT u.*, COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
              (m.enabled_at IS NOT NULL) AS mfa_enabled
       FROM users u LEFT JOIN user_roles r ON r.user_id = u.id LEFT JOIN user_mfa m ON m.user_id = u.id
       GROUP BY u.id, m.enabled_at ORDER BY u.created_at LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ ...r, roles: r.roles.filter(isRole) }));
  }
}
