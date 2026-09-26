import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hasAnyRole, type ChecklistItem, type Role } from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DevIdpService } from '../auth/dev-idp.service';
import { UsersRepository } from '../auth/users.repository';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { BacktestsService } from '../strategies/backtests.service';
import type { RobotRow } from './robots.types';

/** Checklist thresholds (SIMULATED placeholders pending Compliance, OQ-R8). */
export function promotionThresholds(env: NodeJS.ProcessEnv = process.env) {
  const n = (k: string, d: number) => {
    const v = Number(env[k] ?? '');
    return Number.isFinite(v) && (env[k] ?? '') !== '' ? v : d;
  };
  return {
    minOosSharpe: n('KORA_PROMOTE_MIN_OOS_SHARPE', 0.8),
    minOosTrades: n('KORA_PROMOTE_MIN_OOS_TRADES', 100),
    minPaperDays: n('KORA_PROMOTE_MIN_PAPER_DAYS', 30),
    maxTrackingErrorPct: n('KORA_PROMOTE_MAX_TE_PCT', 1),
  };
}

interface SignoffRow {
  id: string;
  limits_hash: string;
  signed_by: string;
  note: string;
  signed_at: Date;
}

/**
 * Promote-to-LIVE workflow (goal 06 §9). The checklist is evidence-based (stored backtest, stored
 * daily tracking, stored four-eyes sign-off bound to the current limits hash), then a TOTP step-up.
 * While `LIVE_TRADING_ENABLED=false` (always, until the Sponsor decides) the request is refused, but
 * it is recorded in `robot_promotions` and audited.
 */
@Injectable()
export class PromotionService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly backtests: BacktestsService,
    private readonly users: UsersRepository,
    private readonly idp: DevIdpService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async robot(id: string): Promise<RobotRow> {
    const r = (await this.db.query<RobotRow>('SELECT * FROM robots WHERE id = $1', [id]))[0];
    if (!r) throw new NotFoundException({ error: 'not_found', message: 'Robot not found.' });
    return r;
  }

  async checklist(
    robot: RobotRow,
    requesterId: string | null,
  ): Promise<{ items: ChecklistItem[]; complete: boolean; liveTradingEnabled: boolean }> {
    const t = promotionThresholds();
    const bt = await this.backtests.latestBacktest(robot.version_id);
    const s = (bt?.summary ?? {}) as { oosSharpe?: number | null; oosTrades?: number };
    const oosSharpe = typeof s.oosSharpe === 'number' ? s.oosSharpe : null;
    const oosTrades = s.oosTrades ?? 0;
    const tracking = await this.db.query<{ tracking_error: number }>(
      'SELECT tracking_error FROM robot_tracking WHERE robot_id = $1 ORDER BY day DESC LIMIT $2',
      [robot.id, Math.max(1, Math.round(t.minPaperDays))],
    );
    const paperDays = robot.paper_started_at
      ? (Date.now() - robot.paper_started_at.getTime()) / 86_400_000
      : 0;
    const te = tracking.length
      ? Math.sqrt(tracking.reduce((a, r) => a + r.tracking_error ** 2, 0) / tracking.length) * 100
      : null;
    const signoff = (
      await this.db.query<SignoffRow>(
        'SELECT * FROM robot_risk_signoffs WHERE robot_id = $1 ORDER BY signed_at DESC LIMIT 1',
        [robot.id],
      )
    )[0];
    const signerRoles = signoff ? await this.users.roles(signoff.signed_by) : [];
    const signoffOk =
      !!signoff &&
      signoff.limits_hash === robot.limits_hash &&
      signoff.signed_by !== robot.owner_id &&
      signoff.signed_by !== requesterId &&
      signerRoles.includes('risk_officer');
    const items: ChecklistItem[] = [
      {
        id: 'oos_sharpe',
        label: `Out-of-sample Sharpe ≥ ${t.minOosSharpe}`,
        pass: oosSharpe !== null && oosSharpe >= t.minOosSharpe,
        evidence: { backtestRunId: bt?.id ?? null, oosSharpe, threshold: String(t.minOosSharpe) },
      },
      {
        id: 'oos_trades',
        label: `≥ ${t.minOosTrades} out-of-sample trades`,
        pass: oosTrades >= t.minOosTrades,
        evidence: { backtestRunId: bt?.id ?? null, oosTrades, threshold: t.minOosTrades },
      },
      {
        id: 'paper_tracking',
        label: `${t.minPaperDays} days paper, tracking error < ${t.maxTrackingErrorPct}%`,
        pass:
          paperDays >= t.minPaperDays &&
          tracking.length >= t.minPaperDays &&
          te !== null &&
          te < t.maxTrackingErrorPct,
        evidence: {
          paperStartedAt: robot.paper_started_at?.toISOString() ?? null,
          paperDays: Math.floor(paperDays),
          trackedDays: tracking.length,
          trackingError30dPct: te === null ? null : te.toFixed(4),
        },
      },
      {
        id: 'risk_signoff',
        label: 'Risk limits reviewed & signed (risk officer, four-eyes)',
        pass: signoffOk,
        evidence: {
          signoffId: signoff?.id ?? null,
          signedBy: signoff?.signed_by ?? null,
          signedAt: signoff?.signed_at.toISOString() ?? null,
          limitsHashMatches: signoff ? signoff.limits_hash === robot.limits_hash : false,
          differentUser: signoff
            ? signoff.signed_by !== robot.owner_id && signoff.signed_by !== requesterId
            : false,
        },
      },
    ];
    return {
      items,
      complete: items.every((i) => i.pass),
      liveTradingEnabled: this.config.liveTradingEnabled,
    };
  }

  async view(userId: string, roles: Role[], robotId: string) {
    const r = await this.robot(robotId);
    if (r.owner_id !== userId && !hasAnyRole(roles, ['risk_officer', 'admin']))
      throw new NotFoundException({ error: 'not_found', message: 'Robot not found.' });
    const c = await this.checklist(r, r.owner_id === userId ? userId : null);
    const history = await this.db.query<{
      id: string;
      outcome: string;
      created_at: Date;
      requested_by: string;
    }>(
      'SELECT id, outcome, created_at, requested_by FROM robot_promotions WHERE robot_id = $1 ORDER BY created_at DESC LIMIT 10',
      [robotId],
    );
    return {
      robotId,
      limits: r.limits,
      limitsHash: r.limits_hash,
      ...c,
      thresholds: promotionThresholds(),
      blockedReason: c.liveTradingEnabled
        ? null
        : 'LIVE trading is disabled on this platform (LIVE_TRADING_ENABLED=false). Only the Sponsor can change that.',
      history: history.map((h) => ({
        id: h.id,
        outcome: h.outcome,
        requestedBy: h.requested_by,
        createdAt: h.created_at.toISOString(),
      })),
    };
  }

  /** Four-eyes: a risk officer who is not the owner signs the exact limits (by hash). */
  async signoff(
    userId: string,
    roles: Role[],
    robotId: string,
    body: { limitsHash: string; note: string },
  ) {
    if (!roles.includes('risk_officer'))
      throw new ForbiddenException({
        error: 'forbidden',
        message: 'Only a risk officer can sign robot risk limits.',
      });
    const r = await this.robot(robotId);
    if (r.owner_id === userId)
      throw new ForbiddenException({
        error: 'four_eyes',
        message:
          'Four-eyes rule: you cannot sign the limits of your own robot. Another risk officer must sign.',
      });
    if (body.limitsHash !== r.limits_hash)
      throw new ConflictException({
        error: 'limits_changed',
        message:
          'The limits changed since you reviewed them. Review the current limits and sign again.',
        limitsHash: r.limits_hash,
      });
    return this.db.tx(async (c) => {
      const row = (
        await c.query<SignoffRow>(
          'INSERT INTO robot_risk_signoffs (robot_id, limits_hash, signed_by, note) VALUES ($1, $2, $3, $4) RETURNING *',
          [robotId, body.limitsHash, userId, body.note],
        )
      ).rows[0]!;
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'robot.risk_signed',
          entity: 'robot',
          entityId: robotId,
          payload: {
            robotId,
            signoffId: row.id,
            limitsHash: body.limitsHash,
            note: body.note,
            ownerId: r.owner_id,
          },
        },
        c,
      );
      return {
        signoffId: row.id,
        robotId,
        limitsHash: row.limits_hash,
        signedBy: userId,
        signedAt: row.signed_at.toISOString(),
      };
    });
  }

  async promote(userId: string, robotId: string, totpCode: string) {
    const r = await this.robot(robotId);
    if (r.owner_id !== userId)
      throw new ForbiddenException({
        error: 'forbidden',
        message: 'Only the robot owner can request promotion.',
      });
    const mfa = await this.idp.verifyStepUp(userId, totpCode);
    if (!mfa) {
      await this.audit.record({
        actorId: userId,
        actorType: 'user',
        action: 'robot.promotion_mfa_failed',
        entity: 'robot',
        entityId: robotId,
        payload: { robotId },
      });
      throw new ForbiddenException({
        error: 'mfa_failed',
        message:
          'That code is not valid. Promotion needs a fresh code from your authenticator app.',
      });
    }
    const c = await this.checklist(r, userId);
    const outcome = !c.complete
      ? 'blocked_checklist'
      : !c.liveTradingEnabled
        ? 'blocked_live_disabled'
        : 'blocked_no_broker';
    const promotion = await this.db.tx(async (cx) => {
      const row = (
        await cx.query<{ id: string; created_at: Date }>(
          'INSERT INTO robot_promotions (robot_id, requested_by, outcome, checklist, mfa_verified) VALUES ($1, $2, $3, $4, true) RETURNING id, created_at',
          [robotId, userId, outcome, JSON.stringify(c.items)],
        )
      ).rows[0]!;
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'robot.promotion_blocked',
          entity: 'robot',
          entityId: robotId,
          payload: {
            robotId,
            promotionId: row.id,
            outcome,
            failed: c.items.filter((i) => !i.pass).map((i) => i.id),
            liveTradingEnabled: c.liveTradingEnabled,
            mfaVerified: true,
          },
        },
        cx,
      );
      return row;
    });
    const messages: Record<string, string> = {
      blocked_checklist: 'Promotion is blocked: every checklist item needs evidence first.',
      blocked_live_disabled:
        'The checklist is complete, but LIVE trading is disabled on this platform (LIVE_TRADING_ENABLED=false). The request was recorded.',
      blocked_no_broker: 'No licensed LIVE broker is connected. The request was recorded.',
    };
    throw new ConflictException({
      error:
        outcome === 'blocked_checklist'
          ? 'checklist_incomplete'
          : outcome === 'blocked_live_disabled'
            ? 'live_trading_disabled'
            : 'no_live_broker',
      message: messages[outcome],
      promotionId: promotion.id,
      items: c.items,
    });
  }
}
