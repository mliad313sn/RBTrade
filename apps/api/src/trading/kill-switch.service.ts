import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AUDIT_READ_ALL_ROLES,
  dec,
  hasAnyRole,
  KILL_SWITCH_SCOPE_LABELS,
  KILL_SWITCH_SCOPE_RANK,
  type KillSwitchRequestWithReason,
  type KillSwitchScope,
  type Role,
} from '@kora/domain';

import { DbService } from '../db/db.service';
import { FourEyesStore, toFourEyesView } from '../governance/four-eyes.store';
import { GOVERNANCE_CONFIG, type GovernanceConfig } from '../governance/governance-config';
import { AccountsService } from './accounts.service';
import { MarketViewService } from './market-view.service';
import { OmsService } from './oms.service';
import { PaperEngineService } from './paper-engine.service';
import { TradingEventsService } from './trading-events.service';
import { TradingRegistryService } from './trading-registry.service';
import type { AccountRow, OrderRow, PositionRow } from './trading.types';
import type { Actor } from './tx';

export const RESUME_ROLES: readonly Role[] = ['trader', 'quant', 'risk_officer', 'admin'];

export interface KillSwitchResult {
  accepted: true;
  scope: KillSwitchScope;
  label: string;
  auditEventId: string;
  engine: 'paper';
  killSwitchId: string;
  accountId: string;
  halted: true;
  alreadyHalted: boolean;
  robotsHalted: boolean;
  ordersCancelled: number;
  positionsFlattened: number;
  flattenPending: Array<{ symbol: string; orderId: string; reason: string }>;
  durationMs: number;
}

/**
 * Kill switch backend (goal 03 §6). One transaction per account: halt flag, cancel every open
 * order, flatten every position at market through the normal engine path, every child action
 * audited. Same REST contract as goal 01 (`{scope, source}` + optional `reason`), usable without
 * the WebSocket.
 */
@Injectable()
export class KillSwitchService {
  constructor(
    private readonly db: DbService,
    private readonly accounts: AccountsService,
    private readonly oms: OmsService,
    private readonly engine: PaperEngineService,
    private readonly registry: TradingRegistryService,
    private readonly market: MarketViewService,
    private readonly events: TradingEventsService,
    private readonly fourEyes: FourEyesStore,
    @Inject(GOVERNANCE_CONFIG) private readonly gov: GovernanceConfig,
  ) {}

  async trigger(userId: string, req: KillSwitchRequestWithReason): Promise<KillSwitchResult> {
    return this.triggerAccount(userId, await this.accounts.ensure(userId), req);
  }

  /**
   * Runs the kill switch on one account for `actorId` (the owner, or a risk officer for a firm
   * halt). `extra` is merged into the parent audit events (e.g. the global kill switch id).
   */
  async triggerAccount(
    actorId: string,
    account: AccountRow,
    req: KillSwitchRequestWithReason,
    extra: Record<string, string> = {},
  ): Promise<KillSwitchResult> {
    const t0 = performance.now();
    const userId = actorId;
    const actor: Actor = { type: 'user', id: actorId };
    const killSwitchId = randomUUID();
    const out = await this.oms.withAccount(account.id, async (tx) => {
      const a = tx.account;
      const alreadyHalted =
        a.trading_halted &&
        KILL_SWITCH_SCOPE_RANK[a.halt_scope!] >= KILL_SWITCH_SCOPE_RANK[req.scope];
      const scope =
        a.trading_halted &&
        KILL_SWITCH_SCOPE_RANK[a.halt_scope!] > KILL_SWITCH_SCOPE_RANK[req.scope]
          ? a.halt_scope!
          : req.scope;
      const upd = await tx.c.query<AccountRow>(
        // A firm halt (actor ≠ owner) always takes ownership of the halt, so only four eyes lift it.
        `UPDATE accounts SET trading_halted = true, halt_scope = $2, halted_at = COALESCE(halted_at, $3),
           halted_by = CASE WHEN $6 THEN $4 ELSE COALESCE(halted_by, $4) END,
           halt_reason = COALESCE($5, halt_reason), updated_at = now() WHERE id = $1 RETURNING *`,
        [a.id, scope, new Date(tx.now), userId, req.reason ?? null, a.user_id !== userId],
      );
      tx.account = upd.rows[0]!;
      tx.changes.accounts.add(a.id);
      const common = {
        killSwitchId,
        accountId: a.id,
        scope: req.scope,
        environment: 'PAPER',
        firm: a.user_id !== actorId,
        ...extra,
      };
      tx.audit(actor, 'kill_switch.requested', 'kill_switch', req.scope, {
        ...common,
        source: req.source,
        reason: req.reason ?? null,
        alreadyHalted,
        engine: 'paper',
      });
      const robotsHalted = !a.trading_halted;
      if (robotsHalted)
        tx.audit(actor, 'kill_switch.robots_halted', 'account', a.id, {
          ...common,
          blocks: 'robot orders',
        });

      let cancelled: OrderRow[] = [];
      if (KILL_SWITCH_SCOPE_RANK[req.scope] >= KILL_SWITCH_SCOPE_RANK.robots_cancel) {
        cancelled = await this.oms.cancelAllOpen(tx, 'kill_switch', actor, { killSwitchId });
      }

      let flattened = 0;
      const pending: KillSwitchResult['flattenPending'] = [];
      if (req.scope === 'robots_cancel_flatten') {
        const positions = await tx.c.query<PositionRow>(
          'SELECT * FROM positions WHERE account_id = $1 AND qty <> 0 ORDER BY symbol FOR UPDATE',
          [a.id],
        );
        for (const p of positions.rows) {
          const r = await this.flatten(tx, p, actor, killSwitchId);
          if (r.status === 'filled') flattened += 1;
          else pending.push({ symbol: p.symbol, orderId: r.id, reason: r.reason });
        }
      }
      const durationMs = Math.round(performance.now() - t0);
      // Goal 09: every kill switch reaches the risk officer console as an alert.
      await tx.c.query(
        `INSERT INTO alerts (severity, kind, account_id, message, details) VALUES ($1, 'kill_switch.fired', $2, $3, $4::jsonb)`,
        [
          common.firm ? 'critical' : 'warning',
          a.id,
          `Kill switch (${KILL_SWITCH_SCOPE_LABELS[req.scope].title}) ${common.firm ? 'fired by the firm' : 'fired by the account holder'}: ${cancelled.length} order(s) cancelled, ${flattened} position(s) flattened${pending.length ? `, ${pending.length} flatten order(s) held` : ''}.`,
          JSON.stringify({ killSwitchId, scope: req.scope, actorId, firm: common.firm, ...extra }),
        ],
      );
      tx.audit(actor, 'kill_switch.completed', 'kill_switch', req.scope, {
        ...common,
        ordersCancelled: cancelled.length,
        positionsFlattened: flattened,
        flattenPending: pending.length,
        durationMs,
      });
      return {
        alreadyHalted,
        robotsHalted,
        cancelled: cancelled.length,
        flattened,
        pending,
        durationMs,
        scope,
      };
    });
    // The first audit event of the batch is the request; its id is returned (goal 01 contract).
    const recent = await this.db.query<{ id: string }>(
      `SELECT id::text AS id FROM audit_events WHERE action = 'kill_switch.requested' AND payload->>'killSwitchId' = $1 ORDER BY id LIMIT 1`,
      [killSwitchId],
    );
    this.events.robotControl({
      action: 'halt',
      accountId: account.id,
      scope: out.scope,
      reason: req.reason ?? null,
      auditEventId: recent[0]!.id,
    });
    return {
      accepted: true,
      scope: req.scope,
      label: KILL_SWITCH_SCOPE_LABELS[req.scope].title,
      auditEventId: recent[0]!.id,
      engine: 'paper',
      killSwitchId,
      accountId: account.id,
      halted: true,
      alreadyHalted: out.alreadyHalted,
      robotsHalted: out.robotsHalted,
      ordersCancelled: out.cancelled,
      positionsFlattened: out.flattened,
      flattenPending: out.pending,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /** Market reduce-only order through the engine; if the market is not safe it stays working (held). */
  private async flatten(
    tx: Parameters<Parameters<OmsService['withAccount']>[1]>[0],
    p: PositionRow,
    actor: Actor,
    killSwitchId: string,
  ) {
    const inst = await this.registry.get(p.symbol);
    const qty = dec(p.qty);
    const side = qty.isPositive() ? 'sell' : 'buy';
    const ins = await tx.c.query<OrderRow>(
      `INSERT INTO orders (account_id, role, symbol, side, type, exec_type, qty, tif, reduce_only, source, status, created_by)
       VALUES ($1, 'primary', $2, $3, 'market', 'market', $4::numeric, 'gtc', true, 'kill-switch', 'new', $5) RETURNING *`,
      [tx.account.id, p.symbol, side, qty.abs().toFixed(), actor.id],
    );
    let order = ins.rows[0]!;
    tx.changes.order(order);
    tx.audit(actor, 'order.new', 'order', order.id, {
      accountId: tx.account.id,
      symbol: p.symbol,
      side,
      type: 'market',
      qty: order.qty,
      source: 'kill-switch',
      killSwitchId,
      environment: 'PAPER',
    });
    order = await this.engine.transition(tx, order, 'accepted', actor, {}, { killSwitchId });
    order = await this.engine.transition(tx, order, 'working', actor, {}, { killSwitchId });
    const snap = await this.market.snapshot(inst, tx.now);
    order = await this.engine.work(tx, order, snap, inst, true);
    const reason =
      order.status === 'filled'
        ? 'filled'
        : snap.safety !== 'ok'
          ? `held: market data ${snap.safety}`
          : snap.session !== 'open'
            ? `held: session ${snap.session}`
            : 'held: insufficient depth';
    if (order.status !== 'filled') {
      tx.audit(actor, 'kill_switch.flatten_pending', 'order', order.id, {
        killSwitchId,
        accountId: tx.account.id,
        symbol: p.symbol,
        reason,
      });
    }
    return { id: order.id, status: order.status, reason };
  }

  /**
   * Four-eyes policy for resuming (goal 09): a firm halt (set by someone other than the owner, e.g.
   * a risk officer or the global kill switch) needs a second person; with `KORA_FOUR_EYES_RESUME=all`
   * every resume does.
   */
  resumeNeedsFourEyes(account: AccountRow): boolean {
    if (this.gov.resumePolicy === 'all') return true;
    return !!account.halted_by && account.halted_by !== account.user_id;
  }

  async resume(userId: string, roles: Role[], reason: string, accountId?: string) {
    if (!hasAnyRole(roles, RESUME_ROLES)) {
      throw new ForbiddenException({
        error: 'forbidden',
        message:
          'Resuming trading needs a trader, quant, risk officer or admin role with two-factor authentication.',
      });
    }
    let target = await this.accounts.ensure(userId);
    if (accountId && accountId !== target.id) {
      if (!hasAnyRole(roles, AUDIT_READ_ALL_ROLES))
        throw new ForbiddenException({
          error: 'forbidden',
          message: 'Only a risk officer or admin can resume another account.',
        });
      const other = await this.accounts.byId(accountId);
      if (!other) throw new NotFoundException({ error: 'not_found', message: 'Account not found' });
      target = other;
    }
    if (!target.trading_halted)
      throw new ConflictException({ error: 'not_halted', message: 'Trading is not halted.' });
    if (this.resumeNeedsFourEyes(target)) {
      const req = await this.fourEyes.create({
        kind: 'kill_switch_resume',
        subjectType: 'account',
        subjectId: target.id,
        payload: {
          accountId: target.id,
          ownerId: target.user_id,
          haltScope: target.halt_scope,
          haltedBy: target.halted_by,
          haltedAt: target.halted_at?.toISOString() ?? null,
          policy: this.gov.resumePolicy,
        },
        reason,
        requestedBy: userId,
      });
      return {
        resumed: false as const,
        accountId: target.id,
        pendingApproval: toFourEyesView(req),
        message:
          'This halt was set by the firm. A second authorised person (risk officer or admin) must approve the resume.',
      };
    }
    return this.executeResume(userId, target.id, reason);
  }

  /** Lifts the halt (after the policy check, or as the executor of an approved four-eyes request). */
  async executeResume(
    actorId: string,
    accountId: string,
    reason: string,
    approval?: { requestId: string; requestedBy: string },
  ) {
    const actor: Actor = { type: 'user', id: actorId };
    return this.oms.withAccount(accountId, async (tx) => {
      if (!tx.account.trading_halted)
        throw new ConflictException({ error: 'not_halted', message: 'Trading is not halted.' });
      const prev = {
        scope: tx.account.halt_scope,
        haltedAt: tx.account.halted_at?.toISOString() ?? null,
        haltedBy: tx.account.halted_by,
      };
      await tx.c.query(
        `UPDATE accounts SET trading_halted = false, halt_scope = NULL, halted_at = NULL, halted_by = NULL, halt_reason = NULL, updated_at = now() WHERE id = $1`,
        [tx.account.id],
      );
      tx.changes.accounts.add(tx.account.id);
      tx.audit(actor, 'kill_switch.resumed', 'account', tx.account.id, {
        accountId: tx.account.id,
        reason,
        previousScope: prev.scope,
        haltedAt: prev.haltedAt,
        haltedBy: prev.haltedBy,
        environment: 'PAPER',
        ...(approval
          ? { fourEyesRequestId: approval.requestId, requestedBy: approval.requestedBy, approvedBy: actorId }
          : {}),
      });
      this.events.robotControl({
        action: 'resume',
        accountId: tx.account.id,
        scope: null,
        reason,
        auditEventId: '',
      });
      return { resumed: true as const, accountId: tx.account.id, previous: prev };
    });
  }

  async state(userId: string) {
    const a = await this.accounts.ensure(userId);
    const pending = a.trading_halted
      ? (await this.fourEyes.list({ status: 'pending', kind: 'kill_switch_resume', subjectId: a.id, limit: 1 }))[0]
      : undefined;
    return {
      accountId: a.id,
      halted: a.trading_halted,
      scope: a.halt_scope,
      haltedAt: a.halted_at?.toISOString() ?? null,
      haltedBy: a.halted_by,
      reason: a.halt_reason,
      /** Goal 09: resuming needs a second person (firm halt, or policy `all`). */
      resumeNeedsApproval: a.trading_halted ? this.resumeNeedsFourEyes(a) : false,
      pendingResume: pending ? toFourEyesView(pending) : null,
    };
  }
}
