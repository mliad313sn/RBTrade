import { randomUUID } from 'node:crypto';

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  dec,
  Decimal,
  KILL_SWITCH_SCOPE_LABELS,
  type KillSwitchScope,
  type RobotLimits,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { RobotBookService } from '../robots/robot-book.service';
import { AccountsService } from '../trading/accounts.service';
import { KillSwitchService } from '../trading/kill-switch.service';
import type { AccountRow } from '../trading/trading.types';
import { FourEyesStore, toFourEyesView } from './four-eyes.store';
import { GOVERNANCE_CONFIG, type GovernanceConfig } from './governance-config';

export interface AlertRow {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  kind: string;
  account_id: string | null;
  message: string;
  details: Record<string, unknown>;
  created_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
}

export const alertView = (a: AlertRow) => ({
  id: a.id,
  severity: a.severity,
  kind: a.kind,
  accountId: a.account_id,
  message: a.message,
  details: a.details,
  createdAt: a.created_at.toISOString(),
  acknowledgedAt: a.acknowledged_at?.toISOString() ?? null,
  acknowledgedBy: a.acknowledged_by,
});

const pct = (num: Decimal, den: Decimal) => (den.gt(0) ? num.div(den).mul(100) : new Decimal(0));
const fmtPct = (d: Decimal) => d.toDecimalPlaces(1).toFixed(1);

/**
 * Risk officer console (goal 09, 2nd line). Every figure comes from the goal 03 engine (valuations,
 * limits, alerts, reconciliation, kill switch audit) or goal 06 robots (supervisor inputs vs limits);
 * nothing is recomputed differently from the engine.
 */
@Injectable()
export class RiskConsoleService {
  constructor(
    @Inject(GOVERNANCE_CONFIG) private readonly cfg: GovernanceConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly killSwitch: KillSwitchService,
    private readonly robotBook: RobotBookService,
    private readonly fourEyes: FourEyesStore,
  ) {}

  /** Accounts worth watching: open exposure, activity in the last 7 days, or halted (capped). */
  private async activeAccounts(limit = 100): Promise<AccountRow[]> {
    return this.db.query<AccountRow>(
      `SELECT a.* FROM accounts a
       WHERE a.status = 'active' AND (a.trading_halted
         OR EXISTS (SELECT 1 FROM positions p WHERE p.account_id = a.id AND p.qty <> 0)
         OR EXISTS (SELECT 1 FROM orders o WHERE o.account_id = a.id AND o.created_at > now() - interval '7 days'))
       ORDER BY a.updated_at DESC LIMIT $1`,
      [limit],
    );
  }

  async exposure() {
    const rows = [];
    const totals = new Map<string, { equity: Decimal; gross: Decimal; dayPnl: Decimal; accounts: number }>();
    for (const a of await this.activeAccounts()) {
      const v = await this.accounts.view(a);
      const limits = v.limits;
      const equity = dec(v.equity);
      const dayLoss = dec(v.dayPnl).isNegative() ? dec(v.dayPnl).neg() : new Decimal(0);
      const weekLoss = dec(v.weekPnl).isNegative() ? dec(v.weekPnl).neg() : new Decimal(0);
      const lev = dec(v.leverage);
      const util = {
        dailyLossPct: pct(dayLoss, dec(limits.dailyLossLimit)),
        weeklyLossPct: pct(weekLoss, dec(limits.weeklyLossLimit)),
        leveragePct: pct(lev, dec(limits.maxLeverage)),
      };
      const worst = Decimal.max(util.dailyLossPct, util.weeklyLossPct, util.leveragePct);
      rows.push({
        accountId: a.id,
        userId: a.user_id,
        baseCurrency: v.baseCurrency,
        equity: v.equity,
        grossExposure: v.grossExposure,
        leverage: v.leverage,
        dayPnl: v.dayPnl,
        weekPnl: v.weekPnl,
        openPositions: v.openPositions,
        limits: {
          dailyLossLimit: limits.dailyLossLimit,
          weeklyLossLimit: limits.weeklyLossLimit,
          maxLeverage: limits.maxLeverage,
          maxOrderNotional: limits.maxOrderNotional,
        },
        limitOverrides: a.limit_overrides ?? {},
        utilisation: {
          dailyLossPct: fmtPct(util.dailyLossPct),
          weeklyLossPct: fmtPct(util.weeklyLossPct),
          leveragePct: fmtPct(util.leveragePct),
          worstPct: fmtPct(worst),
        },
        nearLimit: worst.gte(this.cfg.nearLimitPct),
        halted: v.halt.halted,
        haltScope: v.halt.scope,
        haltedBy: v.halt.haltedBy,
      });
      const t = totals.get(v.baseCurrency) ?? { equity: new Decimal(0), gross: new Decimal(0), dayPnl: new Decimal(0), accounts: 0 };
      t.equity = t.equity.add(equity);
      t.gross = t.gross.add(dec(v.grossExposure));
      t.dayPnl = t.dayPnl.add(dec(v.dayPnl));
      t.accounts += 1;
      totals.set(v.baseCurrency, t);
    }
    rows.sort((x, y) => Number(y.utilisation.worstPct) - Number(x.utilisation.worstPct));
    return {
      nearLimitPct: this.cfg.nearLimitPct,
      firm: [...totals].map(([currency, t]) => ({
        currency,
        accounts: t.accounts,
        equity: t.equity.toFixed(2),
        grossExposure: t.gross.toFixed(2),
        dayPnl: t.dayPnl.toFixed(2),
      })),
      accounts: rows,
    };
  }

  /** Running robots with their usage of each auto-pause limit (goal 06 supervisor inputs). */
  async robotsNearPause() {
    const robots = await this.db.query<{
      id: string;
      name: string;
      owner_id: string;
      account_id: string;
      allocation: string;
      limits: RobotLimits;
      peak_equity: string | null;
      day_start_equity: string | null;
      week_start_equity: string | null;
      base_currency: string;
      last_heartbeat_at: Date | null;
    }>(
      `SELECT r.id, r.name, r.owner_id, r.account_id, r.allocation::text, r.limits, r.peak_equity::text, r.day_start_equity::text,
              r.week_start_equity::text, a.base_currency, r.last_heartbeat_at
       FROM robots r JOIN accounts a ON a.id = r.account_id WHERE r.status = 'running' ORDER BY r.started_at DESC LIMIT 100`,
    );
    const out = [];
    for (const r of robots) {
      const b = await this.robotBook.book(r, r.base_currency);
      const eq = b.equity;
      const peak = r.peak_equity && dec(r.peak_equity).gt(eq) ? dec(r.peak_equity) : eq;
      const day = r.day_start_equity ? dec(r.day_start_equity) : eq;
      const week = r.week_start_equity ? dec(r.week_start_equity) : eq;
      const loss = (start: Decimal) => (start.gt(eq) ? start.sub(eq) : new Decimal(0));
      const ddPct = peak.gt(0) ? peak.sub(eq).div(peak).mul(100) : new Decimal(0);
      const usage = {
        dailyLossPct: pct(loss(day), dec(r.limits.dailyLoss)),
        weeklyLossPct: pct(loss(week), dec(r.limits.weeklyLoss)),
        drawdownPct: pct(ddPct, dec(String(r.limits.maxDrawdownPct))),
      };
      const worst = Decimal.max(usage.dailyLossPct, usage.weeklyLossPct, usage.drawdownPct);
      out.push({
        robotId: r.id,
        name: r.name,
        ownerId: r.owner_id,
        accountId: r.account_id,
        equity: eq.toFixed(2),
        usage: {
          dailyLossPct: fmtPct(usage.dailyLossPct),
          weeklyLossPct: fmtPct(usage.weeklyLossPct),
          drawdownPct: fmtPct(usage.drawdownPct),
          worstPct: fmtPct(worst),
        },
        nearAutoPause: worst.gte(this.cfg.nearPausePct),
        lastHeartbeatAt: r.last_heartbeat_at?.toISOString() ?? null,
      });
    }
    out.sort((x, y) => Number(y.usage.worstPct) - Number(x.usage.worstPct));
    return { nearPausePct: this.cfg.nearPausePct, robots: out };
  }

  async pendingApprovals() {
    const fourEyes = (await this.fourEyes.list({ status: 'pending', limit: 200 })).map(toFourEyesView);
    // Robots whose owner asked for promotion and still lack a valid four-eyes risk sign-off.
    const signoffs = await this.db.query<{ robot_id: string; name: string; owner_id: string; requested_at: Date }>(
      `SELECT DISTINCT ON (p.robot_id) p.robot_id, r.name, r.owner_id, p.created_at AS requested_at
       FROM robot_promotions p JOIN robots r ON r.id = p.robot_id
       WHERE NOT EXISTS (SELECT 1 FROM robot_risk_signoffs s WHERE s.robot_id = r.id AND s.limits_hash = r.limits_hash AND s.signed_by <> r.owner_id)
       ORDER BY p.robot_id, p.created_at DESC LIMIT 100`,
    );
    return {
      fourEyes,
      robotSignoffs: signoffs.map((s) => ({
        robotId: s.robot_id,
        name: s.name,
        ownerId: s.owner_id,
        requestedAt: s.requested_at.toISOString(),
        review: `/robot-reviews/${s.robot_id}`,
      })),
    };
  }

  async killSwitchHistory(limit = 50) {
    return this.db.query<Record<string, unknown>>(
      `SELECT id::text AS "auditId", to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts, actor_id AS "actorId", action,
              payload->>'accountId' AS "accountId", payload->>'scope' AS scope, payload->>'reason' AS reason,
              (payload->>'durationMs')::int AS "durationMs", COALESCE((payload->>'firm')::boolean, false) AS firm,
              payload->>'globalKillSwitchId' AS "globalKillSwitchId", payload->>'fourEyesRequestId' AS "fourEyesRequestId"
       FROM audit_events WHERE action IN ('kill_switch.requested', 'kill_switch.completed', 'kill_switch.resumed', 'risk.global_kill_switch')
       ORDER BY id DESC LIMIT $1`,
      [limit],
    );
  }

  async reconciliation() {
    const runs = await this.db.query<Record<string, unknown>>(
      `SELECT id, trigger, started_at AS "startedAt", finished_at AS "finishedAt", accounts_checked AS "accountsChecked", mismatches, details
       FROM reconciliation_runs WHERE mismatches > 0 ORDER BY started_at DESC LIMIT 20`,
    );
    const last = await this.db.query<Record<string, unknown>>(
      `SELECT id, trigger, started_at AS "startedAt", accounts_checked AS "accountsChecked", mismatches FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1`,
    );
    return { lastRun: last[0] ?? null, breaks: runs };
  }

  async aiRates(days = 7) {
    const r = await this.db.query<{ action: string; n: string }>(
      `SELECT action, count(*)::text AS n FROM audit_events
       WHERE action IN ('ai.draft', 'ai.draft_accepted', 'ai.draft_rejected', 'ai.request') AND ts > now() - make_interval(days => $1)
       GROUP BY action`,
      [days],
    );
    const n = (a: string) => Number(r.find((x) => x.action === a)?.n ?? 0);
    const accepted = n('ai.draft_accepted');
    const rejected = n('ai.draft_rejected');
    const decided = accepted + rejected;
    return {
      days,
      requests: n('ai.request'),
      drafts: n('ai.draft'),
      accepted,
      rejected,
      undecided: Math.max(0, n('ai.draft') - decided),
      acceptanceRatePct: decided ? ((accepted / decided) * 100).toFixed(1) : null,
      rejectionRatePct: decided ? ((rejected / decided) * 100).toFixed(1) : null,
    };
  }

  /** B-810: novice guardrail events (rejections by guardrail, loosening and borrowing requests). */
  async noviceGuardrails(days = 7) {
    const rejections = await this.db.query<{ code: string; n: string; accounts: string }>(
      `SELECT reject_code AS code, count(*)::text AS n, count(DISTINCT account_id)::text AS accounts FROM orders
       WHERE status = 'rejected' AND created_at > now() - make_interval(days => $1)
         AND (reject_code LIKE 'NOVICE_%' OR reject_code IN ('MONTHLY_LOSS_LIMIT', 'DISCLOSURE_NOT_ACKNOWLEDGED'))
       GROUP BY reject_code ORDER BY 2 DESC`,
      [days],
    );
    const loosening = await this.db.query<Record<string, unknown>>(
      `SELECT id::text AS "auditId", to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts, actor_id AS "userId",
              entity_id AS "accountId", payload->'limitsPending' AS pending
       FROM audit_events WHERE action = 'account.settings_updated' AND (payload->>'guarded')::boolean
         AND payload->'limitsPending' <> '{}'::jsonb AND ts > now() - make_interval(days => $1)
       ORDER BY id DESC LIMIT 50`,
      [days],
    );
    // A pattern worth a conduct review: the same account hitting cooling-off on 3+ days.
    const repeat = await this.db.query<{ account_id: string; days: string }>(
      `SELECT account_id, count(DISTINCT created_at::date)::text AS days FROM orders
       WHERE status = 'rejected' AND reject_code = 'NOVICE_COOLING_OFF' AND created_at > now() - interval '30 days'
       GROUP BY account_id HAVING count(DISTINCT created_at::date) >= 3 ORDER BY 2 DESC LIMIT 20`,
    );
    return {
      days,
      rejections: rejections.map((x) => ({ code: x.code, events: Number(x.n), accounts: Number(x.accounts) })),
      looseningRequests: loosening,
      repeatedCoolingOff: repeat.map((x) => ({ accountId: x.account_id, days: Number(x.days) })),
    };
  }

  async alerts(q: { open?: boolean; kind?: string; limit?: number } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.open) where.push('acknowledged_at IS NULL');
    if (q.kind) where.push(`kind LIKE $${params.push(`${q.kind}%`)}`);
    params.push(Math.min(q.limit ?? 100, 500));
    const rows = await this.db.query<AlertRow>(
      `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(alertView);
  }

  async acknowledge(userId: string, id: string, note: string | null) {
    return this.db.tx(async (c) => {
      const r = await c.query<AlertRow>(
        `UPDATE alerts SET acknowledged_at = clock_timestamp(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL RETURNING *`,
        [id, userId],
      );
      const row = r.rows[0] ?? (await c.query<AlertRow>('SELECT * FROM alerts WHERE id = $1', [id])).rows[0];
      if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such alert.' });
      if (r.rows[0])
        await this.audit.record(
          {
            actorId: userId,
            actorType: 'user',
            action: 'risk.alert_acknowledged',
            entity: 'alert',
            entityId: id,
            payload: { alertId: id, kind: row.kind, severity: row.severity, note, ...(row.account_id ? { accountId: row.account_id } : {}) },
          },
          c,
        );
      return alertView(row);
    });
  }

  async overview() {
    const [exposure, robots, approvals, killSwitch, reconciliation, ai, novice, alerts, breaches, incidents] = await Promise.all([
      this.exposure(),
      this.robotsNearPause(),
      this.pendingApprovals(),
      this.killSwitchHistory(20),
      this.reconciliation(),
      this.aiRates(),
      this.noviceGuardrails(),
      this.alerts({ limit: 50 }),
      this.alerts({ kind: 'risk.limit_breach', limit: 50 }),
      this.db.query<Record<string, unknown>>(
        `SELECT id, ref, title, category, status, priority, exercise, detected_at AS "detectedAt" FROM incidents WHERE status <> 'closed' ORDER BY logged_at DESC LIMIT 20`,
      ),
    ]);
    return {
      asOf: new Date().toISOString(),
      environment: 'PAPER',
      simulated: true,
      exposure,
      limitBreaches: breaches,
      robots,
      approvals,
      killSwitch,
      reconciliation,
      ai,
      noviceGuardrails: novice,
      alerts,
      openIncidents: incidents,
    };
  }

  /** B-314: firm-wide kill switch (every active account), run by a risk officer or admin. */
  async globalKillSwitch(actorId: string, scope: KillSwitchScope, reason: string) {
    const globalKillSwitchId = randomUUID();
    const t0 = performance.now();
    const accounts = await this.db.query<AccountRow>(`SELECT * FROM accounts WHERE status = 'active' ORDER BY created_at`);
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'risk.global_kill_switch',
      entity: 'kill_switch',
      entityId: scope,
      payload: { globalKillSwitchId, scope, reason, accounts: accounts.length, phase: 'requested', environment: 'PAPER' },
    });
    let ordersCancelled = 0;
    let positionsFlattened = 0;
    const failures: Array<{ accountId: string; error: string }> = [];
    for (const a of accounts) {
      try {
        const r = await this.killSwitch.triggerAccount(actorId, a, { scope, source: 'risk_console', reason }, { globalKillSwitchId });
        ordersCancelled += r.ordersCancelled;
        positionsFlattened += r.positionsFlattened;
      } catch (e) {
        failures.push({ accountId: a.id, error: (e as Error).message.slice(0, 200) });
      }
    }
    const durationMs = Math.round(performance.now() - t0);
    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'risk.global_kill_switch',
      entity: 'kill_switch',
      entityId: scope,
      payload: {
        globalKillSwitchId,
        scope,
        phase: 'completed',
        accounts: accounts.length,
        ordersCancelled,
        positionsFlattened,
        failures: failures.length,
        durationMs,
      },
    });
    return {
      globalKillSwitchId,
      scope,
      label: KILL_SWITCH_SCOPE_LABELS[scope].title,
      accounts: accounts.length,
      ordersCancelled,
      positionsFlattened,
      failures,
      durationMs,
      resume: 'Each account now needs four eyes to resume (firm halt).',
    };
  }
}
