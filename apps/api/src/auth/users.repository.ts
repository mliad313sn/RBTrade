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
  locked_until: Date | null;
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

  /**
   * Replaces a user's roles. New rows record who granted them and, for a four-eyes role grant
   * (IRTC R4-02), who approved it and the request id; existing rows keep their history.
   */
  async setRoles(
    c: Queryable,
    userId: string,
    roles: Role[],
    grantedBy: string | null,
    approval: { approvedBy: string; requestId: string } | null = null,
  ): Promise<void> {
    await c.query('DELETE FROM user_roles WHERE user_id = $1 AND NOT (role = ANY($2::text[]))', [userId, roles]);
    for (const role of roles) {
      await c.query(
        'INSERT INTO user_roles (user_id, role, granted_by, approved_by, four_eyes_request_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [userId, role, grantedBy, approval?.approvedBy ?? null, approval?.requestId ?? null],
      );
    }
  }

  async recordLoginFailure(userId: string, maxFailures: number, lockMinutes: number): Promise<void> {
    await this.db.query(
      `UPDATE users SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
         updated_at = now()
       WHERE id = $1`,
      [userId, maxFailures, lockMinutes],
    );
  }

  async recordLoginSuccess(userId: string): Promise<void> {
    await this.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [
      userId,
    ]);
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
