import { Inject, Injectable, Logger } from '@nestjs/common';
import { requiresMfa, type Role } from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { CryptoBox } from './crypto-box';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password';
import { TokenService } from './token.service';
import { hashRecoveryCode, newRecoveryCode, RECOVERY_CODE_COUNT } from './recovery-codes';
import { base32Decode, generateTotpSecret, otpauthUrl, verifyTotp } from './totp';
import type { Queryable } from '../db/db.service';
import { UsersRepository, type UserRow } from './users.repository';

const MAX_FAILURES = 10;
const LOCK_MINUTES = 15;

export type LoginOutcome =
  | { status: 'ok'; accessToken: string; user: PublicUser }
  | { status: 'mfa_required' | 'mfa_enrollment_required'; mfaToken: string };

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
}

export class AuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_credentials'
      | 'locked'
      | 'email_taken'
      | 'invalid_mfa_token'
      | 'invalid_code'
      | 'mfa_already_enrolled'
      | 'mfa_not_enrolled',
    message: string,
  ) {
    super(message);
  }
}

/** The built-in, OIDC-compatible dev identity provider (ADR 0101). */
@Injectable()
export class DevIdpService {
  private readonly log = new Logger(DevIdpService.name);
  private readonly box: CryptoBox;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {
    if (config.auth.mfaEncKey) {
      this.box = new CryptoBox(config.auth.mfaEncKey);
    } else {
      this.log.warn('KORA_MFA_ENC_KEY not set: TOTP secrets use an ephemeral key (dev only)');
      this.box = CryptoBox.ephemeral();
    }
  }

  private publicUser(u: UserRow, roles: Role[]): PublicUser {
    return { id: u.id, email: u.email, displayName: u.display_name, roles };
  }

  /**
   * B-014: the answer is the same whether or not the e-mail is already registered (no account
   * enumeration). The password is always hashed, so timing matches too; a duplicate is audited.
   * Production sign-up runs through Keycloak's verify-email flow (B-001).
   */
  async signup(input: { email: string; password: string; displayName: string; accountType: 'novice' }, ip: string) {
    const passwordHash = await hashPassword(input.password, this.config.auth.scryptN);
    const roles: Role[] = [input.accountType];
    const generic = { accepted: true as const, mfaRequired: requiresMfa(roles), next: 'sign_in' as const };
    try {
      await this.db.tx(async (c) => {
        const u = await this.users.create(c, { email: input.email, displayName: input.displayName, passwordHash, roles });
        await this.audit.record(
          { actorId: u.id, actorType: 'user', action: 'auth.signup', entity: 'user', entityId: u.id, payload: { accountType: input.accountType, ip } },
          c,
        );
        return u;
      });
    } catch (e) {
      if ((e as { constraint?: string }).constraint !== 'users_email_lower_uq') throw e;
      const existing = await this.users.findByEmail(input.email);
      await this.audit.record({
        actorId: existing?.id ?? 'anonymous',
        actorType: 'user',
        action: 'auth.signup_duplicate',
        entity: 'user',
        entityId: existing?.id ?? null,
        payload: { ip },
      });
    }
    return generic;
  }

  async login(email: string, password: string, ip: string): Promise<LoginOutcome> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.password_hash || user.status !== 'active') {
      await verifyPassword(password, await dummyPasswordHash(this.config.auth.scryptN)); // equalise timing
      await this.audit.record({ actorId: 'anonymous', actorType: 'user', action: 'auth.login_failed', entity: 'user', entityId: null, payload: { reason: 'unknown_or_disabled', ip } });
      throw new AuthError('invalid_credentials', 'Email or password is incorrect');
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      await this.audit.record({ actorId: user.id, actorType: 'user', action: 'auth.login_failed', entity: 'user', entityId: user.id, payload: { reason: 'locked', ip } });
      throw new AuthError('locked', 'Too many failed attempts. Try again later.');
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      await this.users.recordLoginFailure(user.id, MAX_FAILURES, LOCK_MINUTES);
      await this.audit.record({ actorId: user.id, actorType: 'user', action: 'auth.login_failed', entity: 'user', entityId: user.id, payload: { reason: 'bad_password', ip } });
      throw new AuthError('invalid_credentials', 'Email or password is incorrect');
    }
    await this.users.recordLoginSuccess(user.id);
    const roles = await this.users.roles(user.id);
    const mfa = await this.users.mfa(user.id);
    const mfaEnabled = !!mfa?.enabled_at;
    if (requiresMfa(roles) || mfaEnabled) {
      const stage = mfaEnabled ? 'verify' : 'enroll';
      await this.audit.record({ actorId: user.id, actorType: 'user', action: 'auth.password_ok', entity: 'user', entityId: user.id, payload: { next: stage === 'verify' ? 'mfa_required' : 'mfa_enrollment_required', ip } });
      return {
        status: stage === 'verify' ? 'mfa_required' : 'mfa_enrollment_required',
        mfaToken: await this.tokens.issueMfaToken(user.id, stage),
      };
    }
    const accessToken = await this.tokens.issueAccessToken({ sub: user.id, email: user.email, roles, amr: ['pwd'] });
    await this.audit.record({ actorId: user.id, actorType: 'user', action: 'auth.login', entity: 'user', entityId: user.id, payload: { amr: ['pwd'], ip } });
    return { status: 'ok', accessToken, user: this.publicUser(user, roles) };
  }

  private async mfaSubject(mfaToken: string): Promise<{ sub: string; stage: 'verify' | 'enroll' }> {
    try {
      return await this.tokens.verifyMfaToken(mfaToken);
    } catch {
      throw new AuthError('invalid_mfa_token', 'The MFA step has expired. Sign in again.');
    }
  }

  async enroll(mfaToken: string): Promise<{ secret: string; otpauthUrl: string }> {
    const { sub } = await this.mfaSubject(mfaToken);
    const user = await this.users.findById(sub);
    if (!user) throw new AuthError('invalid_mfa_token', 'Unknown user');
    const existing = await this.users.mfa(sub);
    if (existing?.enabled_at) throw new AuthError('mfa_already_enrolled', 'MFA is already set up for this account');
    const secret = generateTotpSecret();
    await this.users.upsertPendingMfa(sub, this.box.seal(secret, sub));
    await this.audit.record({ actorId: sub, actorType: 'user', action: 'auth.mfa_enrollment_started', entity: 'user', entityId: sub, payload: {} });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /**
   * Step-up check for a signed-in user (goal 06 promote-to-LIVE confirmation): verifies a fresh TOTP
   * code against the enrolled secret and consumes its step (replay-protected). Failures are audited.
   */
  async verifyStepUp(userId: string, code: string): Promise<boolean> {
    const mfa = await this.users.mfa(userId);
    if (!mfa?.enabled_at) return false;
    const step = verifyTotp(base32Decode(this.box.open(mfa.totp_secret_enc, userId)), code);
    const ok = step !== null && (await this.db.tx((c) => this.users.consumeMfaStep(c, userId, step)));
    if (!ok)
      await this.audit.record({ actorId: userId, actorType: 'user', action: 'auth.step_up_failed', entity: 'user', entityId: userId, payload: {} });
    return ok;
  }

  /**
   * B-902: replaces the user's recovery codes with a fresh batch and returns them in clear once.
   * Earlier unused codes stop working. Audited without the codes.
   */
  async issueRecoveryCodes(userId: string, c?: Queryable): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const run = async (q: Queryable) => {
      await q.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
      const batch = (await q.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
      await q.query(
        `INSERT INTO mfa_recovery_codes (user_id, code_hash, batch) SELECT $1, h, $3 FROM unnest($2::text[]) AS h`,
        [userId, codes.map((x) => hashRecoveryCode(userId, x)), batch],
      );
      await this.audit.record({ actorId: userId, actorType: 'user', action: 'auth.recovery_codes_issued', entity: 'user', entityId: userId, payload: { count: codes.length, batch } }, q);
    };
    if (c) await run(c);
    else await this.db.tx(run);
    return codes;
  }

  /** B-902: regenerate with a fresh TOTP code (step-up); null when the code is wrong. */
  async regenerateRecoveryCodes(userId: string, totpCode: string): Promise<string[] | null> {
    if (!(await this.verifyStepUp(userId, totpCode))) return null;
    return this.issueRecoveryCodes(userId);
  }

  async recoveryCodesRemaining(userId: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
    return rows[0]?.n ?? 0;
  }

  /**
   * B-902: second factor by a one-time recovery code (lost authenticator). Counts towards the login
   * lockout like a wrong TOTP code. The session is MFA-level (`amr: pwd, mfa`). Replacing the
   * authenticator itself stays the four-eyes `mfa_reset` for privileged roles (goal 09).
   */
  async recover(mfaToken: string, recoveryCode: string, ip: string): Promise<{ accessToken: string; user: PublicUser; remaining: number }> {
    const { sub, stage } = await this.mfaSubject(mfaToken);
    const user = await this.users.findById(sub);
    const mfa = await this.users.mfa(sub);
    if (!user || !mfa?.enabled_at || stage !== 'verify') throw new AuthError('mfa_not_enrolled', 'Two-factor authentication is not set up for this account');
    if (user.locked_until && user.locked_until.getTime() > Date.now()) throw new AuthError('locked', 'Too many failed attempts. Try again later.');
    const used = await this.db.query<{ id: string }>(
      `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
      [sub, hashRecoveryCode(sub, recoveryCode)],
    );
    if (!used[0]) {
      await this.users.recordLoginFailure(sub, MAX_FAILURES, LOCK_MINUTES);
      await this.audit.record({ actorId: sub, actorType: 'user', action: 'auth.mfa_failed', entity: 'user', entityId: sub, payload: { method: 'recovery_code', ip } });
      throw new AuthError('invalid_code', 'That recovery code is not valid or was already used.');
    }
    const remaining = await this.recoveryCodesRemaining(sub);
    const roles = await this.users.roles(sub);
    const accessToken = await this.tokens.issueAccessToken({ sub, email: user.email, roles, amr: ['pwd', 'mfa'] });
    await this.audit.record({ actorId: sub, actorType: 'user', action: 'auth.mfa_recovery_used', entity: 'user', entityId: sub, payload: { remaining, ip } });
    await this.audit.record({ actorId: sub, actorType: 'user', action: 'auth.login', entity: 'user', entityId: sub, payload: { amr: ['pwd', 'mfa'], ip } });
    return { accessToken, user: this.publicUser(user, roles), remaining };
  }

  async verify(
    mfaToken: string,
    code: string,
    ip: string,
  ): Promise<{ accessToken: string; user: PublicUser; enrolled: boolean; recoveryCodes?: string[] }> {
    const { sub } = await this.mfaSubject(mfaToken);
    const user = await this.users.findById(sub);
    const mfa = await this.users.mfa(sub);
    if (!user || !mfa) throw new AuthError('mfa_not_enrolled', 'Set up an authenticator app first');
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new AuthError('locked', 'Too many failed attempts. Try again later.');
    }
    const step = verifyTotp(base32Decode(this.box.open(mfa.totp_secret_enc, sub)), code);
    const wasEnabled = !!mfa.enabled_at;
    const ok = step !== null && (await this.db.tx((c) => this.users.consumeMfaStep(c, sub, step)));
    if (!ok) {
      await this.users.recordLoginFailure(sub, MAX_FAILURES, LOCK_MINUTES);
      await this.audit.record({ actorId: sub, actorType: 'user', action: 'auth.mfa_failed', entity: 'user', entityId: sub, payload: { ip } });
      throw new AuthError('invalid_code', 'That code is not valid. Check your authenticator app and try again.');
    }
    const roles = await this.users.roles(sub);
    const accessToken = await this.tokens.issueAccessToken({ sub, email: user.email, roles, amr: ['pwd', 'otp'] });
    let recoveryCodes: string[] | undefined;
    if (!wasEnabled) {
      await this.audit.record({ actorId: sub, actorType: 'user', action: 'auth.mfa_enrolled', entity: 'user', entityId: sub, payload: { method: 'totp' } });
      recoveryCodes = await this.issueRecoveryCodes(sub); // B-902: shown once, right after enrolment
    }
    await this.audit.record({ actorId: sub, actorType: 'user', action: 'auth.login', entity: 'user', entityId: sub, payload: { amr: ['pwd', 'otp'], ip } });
    return { accessToken, user: this.publicUser(user, roles), enrolled: !wasEnabled, ...(recoveryCodes ? { recoveryCodes } : {}) };
  }
}
