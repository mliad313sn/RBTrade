import { Inject, Injectable, Logger } from '@nestjs/common';
import { dec, Decimal, formatPct } from '@kora/domain';

import { DbService } from '../db/db.service';
import { AccountsService } from './accounts.service';
import { MarketViewService } from './market-view.service';
import { OmsService } from './oms.service';
import { PaperEngineService } from './paper-engine.service';
import { TRADING_CONFIG, type TradingConfig } from './trading-config';
import { TradingRegistryService } from './trading-registry.service';
import type { AccountRow, OrderRow } from './trading.types';
import type { Actor, TradingTx } from './tx';

export const MARGIN_ACTOR: Actor = { type: 'system', id: 'margin-monitor' };

/**
 * Margin call and close-out (IRTC R2-20, OQ-B3; policy decided by the Product Owner under delegated
 * Sponsor authority, PAPER only). Margin level = equity / margin used, in percent:
 *
 * - at or below `KORA_MARGIN_CALL_LEVEL_PCT` (default 100%) a `risk.margin_call` alert is raised
 *   once per episode (the episode ends when the level recovers above the call level);
 * - at or below `KORA_MARGIN_CLOSEOUT_LEVEL_PCT` (default 50%) the position with the largest
 *   unrealised loss is closed at market, then the next, until the level is back above the
 *   close-out level. Close-out orders are reduce-only market orders with source `margin-closeout`,
 *   placed by the system through the normal engine path, fully audited. On a closed or unsafe
 *   market they stay working (held) and fill at the first safe quote.
 */
@Injectable()
export class MarginService {
  private readonly log = new Logger('Margin');
  /** Accounts currently in a margin-call episode (so the alert is raised once). */
  private readonly inCall = new Set<string>();

  constructor(
    @Inject(TRADING_CONFIG) private readonly cfg: TradingConfig,
    private readonly db: DbService,
    private readonly accounts: AccountsService,
    private readonly oms: OmsService,
    private readonly engine: PaperEngineService,
    private readonly registry: TradingRegistryService,
    private readonly market: MarketViewService,
  ) {}

  /** Checks every account with open positions. Returns the number of close-out orders placed. */
  async sweep(now = Date.now()): Promise<number> {
    const rows = await this.db.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM positions WHERE qty <> 0`,
    );
    let placed = 0;
    for (const { account_id } of rows) {
      try {
        placed += await this.checkAccount(account_id, now);
      } catch (e) {
        this.log.warn(`margin check ${account_id}: ${(e as Error).message}`);
      }
    }
    return placed;
  }

  async checkAccount(accountId: string, now = Date.now()): Promise<number> {
    const callLevel = dec(this.cfg.margin.callLevelPct);
    const closeOutLevel = dec(this.cfg.margin.closeOutLevelPct);
    return this.oms.withAccount(
      accountId,
      async (tx) => {
        let placed = 0;
        const tried = new Set<string>();
        for (let i = 0; i < 50; i++) {
          tx.account = await this.reload(tx);
          const v = await this.accounts.value(tx.account, tx.c, now);
          const used = v.summary.marginUsed;
          if (used.lte(0)) {
            this.inCall.delete(accountId);
            return placed;
          }
          const level = v.summary.equity.div(used).mul(100);
          if (level.gt(callLevel)) {
            this.inCall.delete(accountId);
            return placed;
          }
          if (!this.inCall.has(accountId)) {
            this.inCall.add(accountId);
            await this.alert(
              tx,
              'risk.margin_call',
              'warning',
              level,
              v.summary.equity,
              used,
              `Margin call: margin level ${fmt(level)}% (equity ${v.summary.equity.toFixed(2)} ${tx.account.base_currency} for ${used.toFixed(2)} margin used). Positions are closed automatically at ${closeOutLevel.toFixed()}%.`,
            );
          }
          if (level.gt(closeOutLevel)) return placed;

          // Close-out: largest unrealised loss first, skipping positions already being closed.
          const open = await tx.c.query<{ symbol: string }>(
            `SELECT DISTINCT symbol FROM orders WHERE account_id = $1 AND source = 'margin-closeout' AND status = ANY($2)`,
            [tx.account.id, ['new', 'accepted', 'working', 'partially_filled']],
          );
          const closing = new Set(open.rows.map((r) => r.symbol));
          const candidates = v.positions
            .filter((p) => !p.qty.isZero() && !closing.has(p.symbol) && !tried.has(p.symbol))
            .map((p) => ({
              p,
              pnl:
                p.mark && p.fxRate
                  ? p.mark.sub(p.avgPrice).mul(p.qty).mul(p.multiplier).mul(p.fxRate)
                  : new Decimal(0),
            }))
            .sort((a, b) => a.pnl.cmp(b.pnl));
          const next = candidates[0];
          if (!next) return placed;
          tried.add(next.p.symbol);
          await this.alert(
            tx,
            'risk.margin_closeout',
            'critical',
            level,
            v.summary.equity,
            used,
            `Margin close-out: margin level ${fmt(level)}% is at or below ${closeOutLevel.toFixed()}%. Closing ${next.p.symbol} (${next.p.qty.toFixed()}) at market.`,
          );
          await this.closeOut(tx, next.p.symbol, next.p.qty, level);
          placed += 1;
        }
        return placed;
      },
      now,
    );
  }

  private async reload(tx: TradingTx): Promise<AccountRow> {
    const r = await tx.c.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [tx.account.id]);
    return r.rows[0]!;
  }

  private async alert(
    tx: TradingTx,
    kind: 'risk.margin_call' | 'risk.margin_closeout',
    severity: 'warning' | 'critical',
    level: Decimal,
    equity: Decimal,
    used: Decimal,
    message: string,
  ): Promise<void> {
    const details = {
      marginLevelPct: fmt(level),
      equity: equity.toFixed(2),
      marginUsed: used.toFixed(2),
      currency: tx.account.base_currency,
      callLevelPct: this.cfg.margin.callLevelPct,
      closeOutLevelPct: this.cfg.margin.closeOutLevelPct,
      environment: 'PAPER',
    };
    await tx.c.query(
      `INSERT INTO alerts (severity, kind, account_id, message, details) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [severity, kind, tx.account.id, message, JSON.stringify(details)],
    );
    tx.audit(
      MARGIN_ACTOR,
      kind === 'risk.margin_call' ? 'account.margin_call' : 'account.margin_closeout',
      'account',
      tx.account.id,
      {
        accountId: tx.account.id,
        ...details,
      },
    );
  }

  /** Reduce-only market order for the whole position, through the normal engine path. */
  private async closeOut(
    tx: TradingTx,
    symbol: string,
    qty: Decimal,
    level: Decimal,
  ): Promise<OrderRow> {
    const inst = await this.registry.get(symbol);
    const side = qty.isPositive() ? 'sell' : 'buy';
    const ins = await tx.c.query<OrderRow>(
      `INSERT INTO orders (account_id, role, symbol, side, type, exec_type, qty, tif, reduce_only, source, status, created_by)
       VALUES ($1, 'primary', $2, $3, 'market', 'market', $4::numeric, 'gtc', true, 'margin-closeout', 'new', $5) RETURNING *`,
      [tx.account.id, symbol, side, qty.abs().toFixed(), tx.account.user_id],
    );
    let order = ins.rows[0]!;
    tx.changes.order(order);
    tx.audit(MARGIN_ACTOR, 'order.new', 'order', order.id, {
      accountId: tx.account.id,
      symbol,
      side,
      type: 'market',
      qty: order.qty,
      source: 'margin-closeout',
      marginLevelPct: fmt(level),
      environment: 'PAPER',
    });
    order = await this.engine.transition(
      tx,
      order,
      'accepted',
      MARGIN_ACTOR,
      {},
      { reason: 'margin_closeout' },
    );
    order = await this.engine.transition(
      tx,
      order,
      'working',
      MARGIN_ACTOR,
      {},
      { reason: 'margin_closeout' },
    );
    const snap = await this.market.snapshot(inst, tx.now);
    return this.engine.work(tx, order, snap, inst, true);
  }
}

const fmt = (level: Decimal) => formatPct(level.div(100));
