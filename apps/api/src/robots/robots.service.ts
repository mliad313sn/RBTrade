import { createHash } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AUDIT_READ_ALL_ROLES,
  canonicalStrategyJson,
  dec,
  hasAnyRole,
  type JsonValue,
  type RobotLimits,
  type Role,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';
import { BacktestsService } from '../strategies/backtests.service';
import { StrategiesService } from '../strategies/strategies.service';
import { AccountsService } from '../trading/accounts.service';
import type { Actor } from '../trading/tx';
import { RobotBookService } from './robot-book.service';
import { RobotControlService } from './robot-control.service';
import { ROBOT_SELECT, robotDto, type RobotJoinRow, type RobotRow } from './robots.types';

export function limitsHash(l: RobotLimits): string {
  return createHash('sha256').update(canonicalStrategyJson(l)).digest('hex');
}

/** Monday of the UTC week containing `d` (YYYY-MM-DD): the weekly loss limit's reset point. */
export const isoWeekStart = (d: Date): string => {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString()
    .slice(0, 10);
};

export function heartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KORA_ROBOT_HEARTBEAT_MS ?? '');
  return Number.isInteger(n) && n > 0 ? n : 5000;
}

const num = (d: { toFixed: (n?: number) => string }, dp = 2) => d.toFixed(dp);

/**
 * Robot lifecycle and monitoring (goal 06 §7–8). Robots trade the owner's PAPER account through the
 * OMS; this service owns create / start / pause / version switch / limits and the monitor views.
 */
@Injectable()
export class RobotsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly strategies: StrategiesService,
    private readonly backtests: BacktestsService,
    private readonly accounts: AccountsService,
    private readonly book: RobotBookService,
    private readonly control: RobotControlService,
  ) {}

  async row(id: string, c: Queryable = this.db.pool): Promise<RobotJoinRow | null> {
    const r = await c.query<RobotJoinRow>(`${ROBOT_SELECT} WHERE r.id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  /** Owner (or risk officer / admin for reads). */
  async visible(userId: string, roles: Role[], id: string): Promise<RobotJoinRow> {
    const r = await this.row(id);
    if (!r || (r.owner_id !== userId && !hasAnyRole(roles, AUDIT_READ_ALL_ROLES)))
      throw new NotFoundException({ error: 'not_found', message: 'Robot not found.' });
    return r;
  }

  private async owned(userId: string, id: string, c: Queryable): Promise<RobotRow> {
    const r = await c.query<RobotRow>('SELECT * FROM robots WHERE id = $1 FOR UPDATE', [id]);
    const row = r.rows[0];
    if (!row || row.owner_id !== userId)
      throw new NotFoundException({ error: 'not_found', message: 'Robot not found.' });
    return row;
  }

  async create(
    userId: string,
    roles: Role[],
    body: { name: string; versionId: string; allocation: string; limits: RobotLimits },
    /** Goal 08 (B-614): template robots created through the guarded Novice path. */
    opts: { origin?: 'builder' | 'novice_template'; templateId?: string } = {},
  ) {
    const { version, strategy } = await this.strategies.version(userId, roles, body.versionId);
    if (strategy.owner_id !== userId)
      throw new NotFoundException({ error: 'not_found', message: 'Strategy version not found.' });
    const account = await this.accounts.ensure(userId);
    const id = await this.db.tx(async (c) => {
      const r = (
        await c.query<RobotRow>(
          `INSERT INTO robots (owner_id, account_id, strategy_id, version_id, name, allocation, limits, limits_hash, origin, template_id)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10) RETURNING *`,
          [
            userId,
            account.id,
            strategy.id,
            version.id,
            body.name,
            body.allocation,
            JSON.stringify(body.limits),
            limitsHash(body.limits),
            opts.origin ?? 'builder',
            opts.templateId ?? null,
          ],
        )
      ).rows[0]!;
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'robot.created',
          entity: 'robot',
          entityId: r.id,
          payload: {
            robotId: r.id,
            name: r.name,
            strategyId: strategy.id,
            versionId: version.id,
            contentHash: version.content_hash,
            allocation: body.allocation,
            limits: limitsPayload(body.limits),
            mode: 'PAPER',
            origin: opts.origin ?? 'builder',
            ...(opts.templateId ? { templateId: opts.templateId } : {}),
          },
        },
        c,
      );
      return r.id;
    });
    return this.detail(userId, roles, id);
  }

  async list(userId: string) {
    const account = await this.accounts.ensure(userId);
    const rows = (await this.db.query<RobotJoinRow>(
      `${ROBOT_SELECT} WHERE r.owner_id = $1 ORDER BY r.created_at`,
      [userId],
    )) as RobotJoinRow[];
    const beats = await this.control.heartbeats(rows.map((r) => r.id));
    const robots = [];
    for (const r of rows) {
      const b = await this.book.book(r, account.base_currency);
      robots.push({
        ...robotDto(r),
        pnl: num(b.equity.sub(r.allocation)),
        equity: num(b.equity),
        openPositions: b.positions.length,
        lastHeartbeatAt: beats.has(r.id) ? new Date(beats.get(r.id)!).toISOString() : null,
      });
    }
    return { robots, baseCurrency: account.base_currency, environment: 'PAPER' };
  }

  async detail(userId: string, roles: Role[], id: string) {
    const r = await this.visible(userId, roles, id);
    const account = (await this.accounts.byId(r.account_id))!;
    const b = await this.book.book(r, account.base_currency);
    const beats = await this.control.heartbeats([r.id]);
    const ordersLastMinute = await this.book.ordersLastMinute(r);
    const peak = r.peak_equity ? dec(r.peak_equity) : b.equity;
    const dd = peak.gt(0) ? peak.sub(b.equity).div(peak).mul(100) : dec('0');
    const dayPnl = r.day_start_equity ? b.equity.sub(r.day_start_equity) : dec('0');
    const weekPnl = r.week_start_equity ? b.equity.sub(r.week_start_equity) : dec('0');
    const bt = await this.backtests.latestBacktest(r.version_id);
    const wf = (
      await this.db.query<{
        id: string;
        summary: Record<string, unknown>;
        result: Record<string, unknown>;
      }>(
        `SELECT id, summary, result->'metrics' AS result FROM backtest_runs WHERE version_id = $1 AND kind = 'walk_forward' ORDER BY created_at DESC LIMIT 1`,
        [r.version_id],
      )
    )[0];
    const tracking = await this.db.query<{
      day: string;
      live_return: number;
      backtest_return: number;
      tracking_error: number;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, live_return, backtest_return, tracking_error FROM robot_tracking WHERE robot_id = $1 ORDER BY day DESC LIMIT 30`,
      [r.id],
    );
    const te30 = tracking.length
      ? Math.sqrt(tracking.reduce((s, t) => s + t.tracking_error ** 2, 0) / tracking.length)
      : null;
    return {
      ...robotDto(r),
      baseCurrency: account.base_currency,
      accountHalted: account.trading_halted,
      lastHeartbeatAt: beats.has(r.id) ? new Date(beats.get(r.id)!).toISOString() : null,
      heartbeatMs: heartbeatMs(),
      book: {
        equity: num(b.equity),
        pnl: num(b.equity.sub(r.allocation)),
        realised: num(b.realised),
        unrealised: num(b.unrealised),
        costs: num(b.costs),
        grossExposure: num(b.grossExposure),
        positions: b.positions.map((p) => ({
          symbol: p.symbol,
          qty: p.qty.toFixed(),
          avgPrice: p.avgPrice.toFixed(),
          mark: p.mark?.toFixed() ?? null,
          unrealised: num(p.unrealised),
          openedAt: new Date(p.openedAt).toISOString(),
        })),
      },
      limitsUsage: {
        dailyLoss: { used: num(dayPnl.lt(0) ? dayPnl.neg() : dec('0')), limit: r.limits.dailyLoss },
        weeklyLoss: {
          used: num(weekPnl.lt(0) ? weekPnl.neg() : dec('0')),
          limit: r.limits.weeklyLoss,
        },
        maxDrawdownPct: {
          used: dd.lt(0) ? '0.00' : num(dd),
          limit: String(r.limits.maxDrawdownPct),
        },
        ordersPerMinute: {
          used: String(ordersLastMinute),
          limit: String(r.limits.ordersPerMinute),
        },
        grossExposure: {
          used: b.equity.gt(0) ? num(b.grossExposure.div(b.equity)) : '0.00',
          limit: String(r.limits.grossExposure),
        },
      },
      kpis: {
        backtestRunId: bt?.id ?? null,
        inSample:
          (bt?.result as { metrics?: { inSample?: unknown } } | undefined)?.metrics?.inSample ??
          null,
        outOfSample:
          (bt?.result as { metrics?: { outOfSample?: unknown } } | undefined)?.metrics
            ?.outOfSample ?? null,
        walkForwardRunId: wf?.id ?? null,
        walkForward: wf?.result ?? null,
        live: {
          days: tracking.length,
          trackingError30dPct: te30 === null ? null : te30 * 100,
          pnl: num(b.equity.sub(r.allocation)),
          returnPct: num(b.equity.sub(r.allocation).div(r.allocation).mul(100)),
          fills: b.fills,
        },
      },
      tracking,
    };
  }

  async start(userId: string, id: string) {
    const account = await this.accounts.ensure(userId);
    const r = await this.db.tx(async (c) => {
      const row = await this.owned(userId, id, c);
      if (row.status === 'running') return row;
      if (row.status === 'stopped')
        throw new ConflictException({
          error: 'robot_stopped',
          message: 'This robot is stopped. Create a new robot to trade again.',
        });
      const acc = await this.accounts.byId(row.account_id, c);
      if (acc?.trading_halted)
        throw new ConflictException({
          error: 'trading_halted',
          message:
            'Trading is halted by the kill switch. Resume trading first, then start the robot.',
        });
      // Drawdown and loss baselines exist from the first instant the robot runs: without them the
      // supervisor would take its first pass as the peak, and a crash before that pass (a fill
      // followed by a gap within one supervision interval) would never count as a drawdown.
      const eq = (
        await this.book.book(row, acc?.base_currency ?? account.base_currency, c)
      ).equity.toFixed(10);
      const now = new Date();
      const upd = (
        await c.query<RobotRow>(
          `UPDATE robots SET status = 'running', started_at = now(), paper_started_at = COALESCE(paper_started_at, now()),
             pause_reason = NULL, paused_at = NULL, updated_at = now(),
             peak_equity = COALESCE(peak_equity, $2::numeric),
             day_start_equity = CASE WHEN day_start = $3 AND day_start_equity IS NOT NULL THEN day_start_equity ELSE $2::numeric END,
             day_start = $3,
             week_start_equity = CASE WHEN week_start = $4 AND week_start_equity IS NOT NULL THEN week_start_equity ELSE $2::numeric END,
             week_start = $4
           WHERE id = $1 RETURNING *`,
          [id, eq, now.toISOString().slice(0, 10), isoWeekStart(now)],
        )
      ).rows[0]!;
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'robot.started',
          entity: 'robot',
          entityId: id,
          payload: { robotId: id, versionId: row.version_id, mode: 'PAPER', accountId: account.id },
        },
        c,
      );
      return upd;
    });
    this.control.sync(r.account_id, r.id, r.status);
    return { id: r.id, status: r.status, startedAt: r.started_at?.toISOString() ?? null };
  }

  async pause(userId: string, id: string, reason: string) {
    const row = await this.db.query<RobotRow>('SELECT * FROM robots WHERE id = $1', [id]);
    if (!row[0] || row[0].owner_id !== userId)
      throw new NotFoundException({ error: 'not_found', message: 'Robot not found.' });
    const out = await this.pauseRobot(id, reason, { type: 'user', id: userId }, {});
    return { id, status: 'paused', changed: out !== null, reason };
  }

  /**
   * Pauses a running robot (user, supervisor, kill switch). Idempotent: returns null if it was not
   * running. Automatic pauses raise an alert.
   */
  async pauseRobot(
    id: string,
    reason: string,
    actor: Actor,
    details: Record<string, JsonValue>,
    alert?: { severity: 'warning' | 'critical'; message: string },
  ) {
    const r = await this.db.tx(async (c) => {
      const upd = (
        await c.query<RobotRow>(
          `UPDATE robots SET status = 'paused', pause_reason = $2, paused_at = now(), updated_at = now() WHERE id = $1 AND status = 'running' RETURNING *`,
          [id, reason],
        )
      ).rows[0];
      if (!upd) return null;
      await this.audit.record(
        {
          actorId: actor.id,
          actorType: actor.type,
          action: actor.type === 'user' ? 'robot.paused' : 'robot.auto_paused',
          entity: 'robot',
          entityId: id,
          payload: { robotId: id, reason, accountId: upd.account_id, ...details },
        },
        c,
      );
      if (alert)
        await c.query(
          `INSERT INTO alerts (severity, kind, account_id, message, details) VALUES ($1, $2, $3, $4, $5)`,
          [
            alert.severity,
            `robot.${reason}`,
            upd.account_id,
            alert.message,
            JSON.stringify({ robotId: id, reason, ...details }),
          ],
        );
      return upd;
    });
    if (r) this.control.sync(r.account_id, r.id, 'paused');
    return r;
  }

  async switchVersion(userId: string, id: string, versionId: string, reason: string) {
    return this.db.tx(async (c) => {
      const row = await this.owned(userId, id, c);
      if (row.status === 'running')
        throw new ConflictException({
          error: 'robot_running',
          message: 'Pause the robot before switching its strategy version.',
        });
      const v = (
        await c.query<{ id: string; strategy_id: string; content_hash: string; version: number }>(
          'SELECT id, strategy_id, content_hash, version FROM strategy_versions WHERE id = $1',
          [versionId],
        )
      ).rows[0];
      if (!v || v.strategy_id !== row.strategy_id)
        throw new NotFoundException({
          error: 'not_found',
          message: 'That version does not belong to this robot’s strategy.',
        });
      const prev = (
        await c.query<{ content_hash: string; version: number }>(
          'SELECT content_hash, version FROM strategy_versions WHERE id = $1',
          [row.version_id],
        )
      ).rows[0]!;
      await c.query('UPDATE robots SET version_id = $2, updated_at = now() WHERE id = $1', [
        id,
        versionId,
      ]);
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'robot.version_changed',
          entity: 'robot',
          entityId: id,
          payload: {
            robotId: id,
            fromVersion: prev.version,
            toVersion: v.version,
            fromHash: prev.content_hash,
            toHash: v.content_hash,
            reason,
          },
        },
        c,
      );
      return { id, versionId, version: v.version, contentHash: v.content_hash };
    });
  }

  async updateLimits(userId: string, id: string, limits: RobotLimits, reason: string) {
    return this.db.tx(async (c) => {
      const row = await this.owned(userId, id, c);
      if (row.status === 'running')
        throw new ConflictException({
          error: 'robot_running',
          message: 'Pause the robot before changing its risk limits.',
        });
      const hash = limitsHash(limits);
      await c.query(
        'UPDATE robots SET limits = $2, limits_hash = $3, updated_at = now() WHERE id = $1',
        [id, JSON.stringify(limits), hash],
      );
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'robot.limits_changed',
          entity: 'robot',
          entityId: id,
          payload: {
            robotId: id,
            from: limitsPayload(row.limits),
            to: limitsPayload(limits),
            limitsHash: hash,
            reason,
            signoffInvalidated: row.limits_hash !== hash,
          },
        },
        c,
      );
      return { id, limits, limitsHash: hash };
    });
  }

  async signals(userId: string, roles: Role[], id: string, limit = 50) {
    await this.visible(userId, roles, id);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, version_id, symbol, bar_ts, action, reason, conditions, features, outcome, outcome_detail, order_id, created_at
       FROM robot_signals WHERE robot_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [id, Math.min(Math.max(limit, 1), 200)],
    );
    return { signals: rows.map(signalDto) };
  }

  /** Robot, strategy and robot-actor events (the monitor's live audit feed). */
  async auditFeed(userId: string, roles: Role[], id: string, limit = 50) {
    const r = await this.visible(userId, roles, id);
    const rows = await this.db.query<{
      id: string;
      ts: Date;
      actor_type: string;
      actor_id: string;
      action: string;
      entity: string;
      entity_id: string | null;
      payload: unknown;
    }>(
      `SELECT id::text AS id, ts, actor_type, actor_id, action, entity, entity_id, payload FROM audit_events
       WHERE (entity = 'robot' AND entity_id = $1) OR (actor_type = 'robot' AND actor_id = $1) OR (entity = 'strategy' AND entity_id = $2)
       ORDER BY id DESC LIMIT $3`,
      [id, r.strategy_id, Math.min(Math.max(limit, 1), 200)],
    );
    return {
      events: rows.map((e) => ({
        id: e.id,
        ts: e.ts.toISOString(),
        actorType: e.actor_type,
        actorId: e.actor_id,
        action: e.action,
        entity: e.entity,
        entityId: e.entity_id,
        payload: e.payload,
      })),
    };
  }

  async signalFeatures(userId: string, roles: Role[], signalId: string) {
    const rows = await this.db.query<Record<string, unknown> & { robot_id: string }>(
      `SELECT s.*, r.owner_id FROM robot_signals s JOIN robots r ON r.id = s.robot_id WHERE s.id = $1`,
      [signalId],
    );
    const s = rows[0] as
      | (Record<string, unknown> & { owner_id: string; robot_id: string })
      | undefined;
    if (!s || (s.owner_id !== userId && !hasAnyRole(roles, AUDIT_READ_ALL_ROLES)))
      throw new NotFoundException({ error: 'not_found', message: 'Signal not found.' });
    return {
      ...signalDto(s),
      robotId: s.robot_id,
      explanation:
        'Contributions are the signed, scaled distance of each condition from its threshold (tanh-squashed to −1…1), not a model attribution.',
    };
  }

  async requireOwner(userId: string, id: string): Promise<RobotRow> {
    const r = await this.db.query<RobotRow>('SELECT * FROM robots WHERE id = $1', [id]);
    if (!r[0]) throw new NotFoundException({ error: 'not_found', message: 'Robot not found.' });
    if (r[0].owner_id !== userId)
      throw new ForbiddenException({
        error: 'forbidden',
        message: 'Only the robot owner can do this.',
      });
    return r[0];
  }
}

function limitsPayload(l: RobotLimits): Record<string, string | number> {
  return {
    dailyLoss: l.dailyLoss,
    weeklyLoss: l.weeklyLoss,
    maxDrawdownPct: String(l.maxDrawdownPct),
    ordersPerMinute: l.ordersPerMinute,
    grossExposure: String(l.grossExposure),
  };
}

export function signalDto(s: Record<string, unknown>) {
  return {
    id: s.id,
    versionId: s.version_id,
    symbol: s.symbol,
    barTs: (s.bar_ts as Date).toISOString(),
    action: s.action,
    reason: s.reason,
    conditions: s.conditions,
    features: s.features,
    outcome: s.outcome,
    outcomeDetail: s.outcome_detail,
    orderId: s.order_id ?? null,
    createdAt: (s.created_at as Date).toISOString(),
  };
}
