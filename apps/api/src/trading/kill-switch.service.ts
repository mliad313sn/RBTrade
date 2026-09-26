import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
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
  ) {}

  async trigger(userId: string, req: KillSwitchRequestWithReason): Promise<KillSwitchResult> {
    const t0 = performance.now();
    const account = await this.accounts.ensure(userId);
    const actor: Actor = { type: 'user', id: userId };
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
        `UPDATE accounts SET trading_halted = true, halt_scope = $2, halted_at = COALESCE(halted_at, $3), halted_by = COALESCE(halted_by, $4),
           halt_reason = COALESCE($5, halt_reason), updated_at = now() WHERE id = $1 RETURNING *`,
        [a.id, scope, new Date(tx.now), userId, req.reason ?? null],
      );
      tx.account = upd.rows[0]!;
      tx.changes.accounts.add(a.id);
      const common = { killSwitchId, accountId: a.id, scope: req.scope, environment: 'PAPER' };
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
    const actor: Actor = { type: 'user', id: userId };
    return this.oms.withAccount(target.id, async (tx) => {
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
      });
      this.events.robotControl({
        action: 'resume',
        accountId: tx.account.id,
        scope: null,
        reason,
        auditEventId: '',
      });
      return { resumed: true, accountId: tx.account.id, previous: prev };
    });
  }

  async state(userId: string) {
    const a = await this.accounts.ensure(userId);
    return {
      accountId: a.id,
      halted: a.trading_halted,
      scope: a.halt_scope,
      haltedAt: a.halted_at?.toISOString() ?? null,
      haltedBy: a.halted_by,
      reason: a.halt_reason,
    };
  }
}
