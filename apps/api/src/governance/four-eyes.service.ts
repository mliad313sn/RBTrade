import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  APPROVER_ROLES,
  dec,
  hasAnyRole,
  isNoviceOnly,
  type FourEyesCreate,
  type JsonValue,
  type Role,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { UsersRepository } from '../auth/users.repository';
import { DbService, type Queryable } from '../db/db.service';
import { DbDisclosureRegistry } from '../disclosures/db-disclosure-registry';
import { AccountsService } from '../trading/accounts.service';
import { KillSwitchService } from '../trading/kill-switch.service';
import { FourEyesStore, toFourEyesView, type FourEyesRow, type FourEyesView } from './four-eyes.store';

/**
 * Four-eyes workflow (goal 09): who may request what, who may decide, and what an approval does.
 * The store enforces "approver ≠ requester" (and the database trigger does it again); this service
 * adds "approver ≠ the person the request is about" and runs the approved action with both names in
 * the audit trail.
 */
@Injectable()
export class FourEyesService {
  constructor(
    private readonly db: DbService,
    private readonly store: FourEyesStore,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsService,
    private readonly accounts: AccountsService,
    private readonly killSwitch: KillSwitchService,
    private readonly disclosures: DbDisclosureRegistry,
  ) {}

  async list(q: Parameters<FourEyesStore['list']>[0]): Promise<FourEyesView[]> {
    return (await this.store.list(q)).map(toFourEyesView);
  }

  async get(id: string): Promise<FourEyesView> {
    return toFourEyesView(await this.store.get(id));
  }

  async create(userId: string, roles: Role[], body: FourEyesCreate): Promise<FourEyesView> {
    switch (body.kind) {
      case 'limit_override': {
        const account = await this.accounts.byId(body.accountId);
        if (!account) throw new NotFoundException({ error: 'not_found', message: 'Account not found' });
        const own = account.user_id === userId;
        if (!own && !hasAnyRole(roles, APPROVER_ROLES))
          throw new ForbiddenException({ error: 'forbidden', message: 'Only the account holder or a risk officer can request this.' });
        const ownerRoles = await this.users.roles(account.user_id);
        if (isNoviceOnly(ownerRoles))
          throw new ForbiddenException({
            error: 'guarded_account',
            message: 'Guarded (Novice) accounts cannot have limits above the platform defaults.',
          });
        const platform = this.accounts.platformLimits({ ...account, limit_overrides: {} });
        for (const [field, value] of Object.entries(body.limits)) {
          const cur = String((platform as unknown as Record<string, string | number>)[field]);
          if (!dec(value!).gt(dec(cur)))
            throw new BadRequestException({
              error: 'not_a_loosening',
              message: `${field} ${value} is not above the platform limit ${cur}. Tighten limits in your own settings instead.`,
            });
        }
        return toFourEyesView(
          await this.store.create({
            kind: 'limit_override',
            subjectType: 'account',
            subjectId: account.id,
            payload: { accountId: account.id, ownerId: account.user_id, limits: body.limits, platform: platform as unknown as JsonValue },
            reason: body.reason,
            requestedBy: userId,
          }),
        );
      }
      case 'mfa_reset': {
        if (!roles.includes('admin'))
          throw new ForbiddenException({ error: 'forbidden', message: 'Only an admin can request a two-factor reset.' });
        if (body.userId === userId)
          throw new ForbiddenException({ error: 'four_eyes', message: 'You cannot request a two-factor reset for yourself.' });
        const target = await this.users.findById(body.userId);
        if (!target) throw new NotFoundException({ error: 'not_found', message: 'User not found' });
        return toFourEyesView(
          await this.store.create({
            kind: 'mfa_reset',
            subjectType: 'user',
            subjectId: body.userId,
            payload: { userId: body.userId },
            reason: body.reason,
            requestedBy: userId,
          }),
        );
      }
      case 'disclosure_publish': {
        if (!hasAnyRole(roles, APPROVER_ROLES))
          throw new ForbiddenException({ error: 'forbidden', message: 'Only a risk officer or admin can request a publication.' });
        let subjectId: string;
        const payload: Record<string, JsonValue> = {
          jurisdiction: body.jurisdiction,
          effectiveFrom: body.effectiveFrom ?? null,
        };
        if (body.document) {
          const d = await this.db.query<{ status: string; drafted_by: string }>(
            'SELECT status, drafted_by FROM disclosure_documents WHERE id = $1 AND version = $2 AND jurisdiction = $3',
            [body.document.disclosureId, body.document.version, body.jurisdiction],
          );
          if (!d[0]) throw new NotFoundException({ error: 'not_found', message: 'No such draft. Draft the version first.' });
          if (d[0].status !== 'draft')
            throw new ConflictException({ error: 'already_published', message: 'This version is already published.' });
          subjectId = `${body.document.disclosureId}:${body.document.version}:${body.jurisdiction}`;
          payload.document = { ...body.document, draftedBy: d[0].drafted_by };
        } else {
          const v = body.value!;
          if (v.key === 'retailLossPct' && v.value !== null && (!/^\d{1,2}(\.\d{1,2})?$/.test(v.value) || Number(v.value) > 100))
            throw new BadRequestException({ error: 'invalid_value', message: 'retailLossPct is a percentage such as 74 or 74.5.' });
          subjectId = `value:${v.key}:${body.jurisdiction}`;
          payload.value = v;
        }
        return toFourEyesView(
          await this.store.create({
            kind: 'disclosure_publish',
            subjectType: 'disclosure',
            subjectId,
            payload,
            reason: body.reason,
            requestedBy: userId,
          }),
        );
      }
    }
  }

  private assertApprover(roles: Role[]): void {
    if (!hasAnyRole(roles, APPROVER_ROLES))
      throw new ForbiddenException({ error: 'forbidden', message: 'Only a risk officer or admin can decide four-eyes requests.' });
  }

  /** The approver may not be the person the request is about (account owner, MFA subject, drafter). */
  private assertIndependent(row: FourEyesRow, deciderId: string): void {
    const p = row.payload as Record<string, JsonValue>;
    const about =
      row.kind === 'limit_override' || row.kind === 'kill_switch_resume'
        ? (p.ownerId as string | undefined)
        : row.kind === 'mfa_reset'
          ? (p.userId as string | undefined)
          : ((p.document as { draftedBy?: string } | undefined)?.draftedBy ?? undefined);
    if (about && about === deciderId)
      throw new ForbiddenException({
        error: 'four_eyes',
        message: 'Four-eyes rule: you cannot decide a request about your own account, credentials or draft.',
      });
  }

  async approve(userId: string, roles: Role[], id: string, note: string): Promise<FourEyesView> {
    this.assertApprover(roles);
    let refreshDisclosures = false;
    const row = await this.db.tx(async (c) => {
      const r = await this.store.lockPending(c, id, userId);
      this.assertIndependent(r, userId);
      const result = await this.execute(c, r, userId);
      if (r.kind === 'disclosure_publish') refreshDisclosures = true;
      return this.store.decide(c, r, userId, 'approved', note, result);
    });
    if (refreshDisclosures) await this.disclosures.refresh();
    return toFourEyesView(row);
  }

  async reject(userId: string, roles: Role[], id: string, note: string): Promise<FourEyesView> {
    this.assertApprover(roles);
    return toFourEyesView(
      await this.db.tx(async (c) => {
        const r = await this.store.lockPending(c, id, userId);
        return this.store.decide(c, r, userId, 'rejected', note);
      }),
    );
  }

  /** Only the requester may withdraw a pending request. */
  async cancel(userId: string, id: string, note: string): Promise<FourEyesView> {
    return toFourEyesView(
      await this.db.tx(async (c) => {
        await this.store.expireStale(c);
        const r = (await c.query<FourEyesRow>('SELECT * FROM four_eyes_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!r) throw new NotFoundException({ error: 'not_found', message: 'No such request.' });
        if (r.requested_by !== userId)
          throw new ForbiddenException({ error: 'forbidden', message: 'Only the person who asked can withdraw a request.' });
        if (r.status !== 'pending')
          throw new ConflictException({ error: 'not_pending', message: `This request is already ${r.status}.` });
        return this.store.decide(c, r, userId, 'cancelled', note);
      }),
    );
  }

  /** Runs the approved action inside the approval transaction (kill-switch resume uses its own). */
  private async execute(c: Queryable, r: FourEyesRow, approver: string): Promise<Record<string, JsonValue>> {
    const p = r.payload as Record<string, JsonValue>;
    switch (r.kind) {
      case 'limit_override': {
        const limits = p.limits as Record<string, string>;
        const upd = await c.query<{ limit_overrides: Record<string, string> }>(
          'UPDATE accounts SET limit_overrides = limit_overrides || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING limit_overrides',
          [r.subject_id, JSON.stringify(limits)],
        );
        if (!upd.rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Account not found' });
        await this.audit.record(
          {
            actorId: approver,
            actorType: 'user',
            action: 'account.limit_override_applied',
            entity: 'account',
            entityId: r.subject_id,
            payload: { accountId: r.subject_id, limits, requestId: r.id, requestedBy: r.requested_by, approvedBy: approver },
          },
          c,
        );
        return { accountId: r.subject_id, limitOverrides: upd.rows[0].limit_overrides };
      }
      case 'kill_switch_resume': {
        // The resume takes the account lock in its own transaction; this row stays locked meanwhile.
        const out = await this.killSwitch.executeResume(approver, r.subject_id, r.reason, {
          requestId: r.id,
          requestedBy: r.requested_by,
        });
        return { resumed: true, accountId: out.accountId, previousScope: out.previous.scope };
      }
      case 'mfa_reset': {
        const del = await c.query('DELETE FROM user_mfa WHERE user_id = $1', [r.subject_id]);
        // Goal 10: old recovery codes and sessions end with the reset (B-902).
        await c.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [r.subject_id]);
        await this.sessions.invalidateAll(r.subject_id, c);
        await this.audit.record(
          {
            actorId: approver,
            actorType: 'user',
            action: 'auth.mfa_reset',
            entity: 'user',
            entityId: r.subject_id,
            payload: { userId: r.subject_id, hadMfa: (del.rowCount ?? 0) > 0, requestId: r.id, requestedBy: r.requested_by, approvedBy: approver },
          },
          c,
        );
        return { userId: r.subject_id, reset: true };
      }
      case 'disclosure_publish': {
        const effectiveFrom = (p.effectiveFrom as string | null) ?? null;
        if (p.document) {
          const d = p.document as { disclosureId: string; version: string };
          const upd = await c.query(
            `UPDATE disclosure_documents SET status = 'published', effective_from = COALESCE($4::timestamptz, clock_timestamp()),
               approved_by = $5, approval_request_id = $6, published_at = clock_timestamp()
             WHERE id = $1 AND version = $2 AND jurisdiction = $3 AND status = 'draft' RETURNING effective_from`,
            [d.disclosureId, d.version, p.jurisdiction, effectiveFrom, approver, r.id],
          );
          if (!upd.rowCount) throw new ConflictException({ error: 'not_draft', message: 'The draft no longer exists or is already published.' });
          await this.audit.record(
            {
              actorId: approver,
              actorType: 'user',
              action: 'disclosure.published',
              entity: 'disclosure',
              entityId: d.disclosureId,
              payload: { ...d, jurisdiction: p.jurisdiction as string, effectiveFrom, requestId: r.id, requestedBy: r.requested_by, approvedBy: approver },
            },
            c,
          );
          return { published: `${d.disclosureId} v${d.version} (${p.jurisdiction as string})` };
        }
        const v = p.value as { key: string; value: string | null };
        const prev = await c.query<{ owner: string; open_question: string | null }>(
          `SELECT owner, open_question FROM disclosure_values WHERE key = $1 ORDER BY (jurisdiction = $2) DESC, effective_from DESC LIMIT 1`,
          [v.key, p.jurisdiction],
        );
        await c.query(
          `INSERT INTO disclosure_values (key, jurisdiction, effective_from, value, owner, open_question, set_by)
           VALUES ($1, $2, COALESCE($3::timestamptz, clock_timestamp()), $4, $5, $6, $7)`,
          [v.key, p.jurisdiction, effectiveFrom, v.value, prev.rows[0]?.owner ?? 'Compliance', prev.rows[0]?.open_question ?? null, approver],
        );
        await this.audit.record(
          {
            actorId: approver,
            actorType: 'user',
            action: 'disclosure.value_set',
            entity: 'disclosure_value',
            entityId: v.key,
            payload: { key: v.key, value: v.value, jurisdiction: p.jurisdiction as string, effectiveFrom, requestId: r.id, requestedBy: r.requested_by, approvedBy: approver },
          },
          c,
        );
        return { key: v.key, value: v.value, jurisdiction: p.jurisdiction as string };
      }
    }
  }
}
