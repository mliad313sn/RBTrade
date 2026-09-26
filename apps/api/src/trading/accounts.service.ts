import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  CONFIRM_MODES,
  CURRENCY_RE,
  dec,
  depositJournal,
  formatAmount,
  formatPct,
  markFor,
  summarizeAccount,
  type AccountSummary,
  type ConfirmSettings,
  type Decimal,
  type PositionDto,
  type RiskLimits,
  type ValuedPosition,
} from '@kora/domain';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';
import { FxService } from './fx.service';
import { LedgerService } from './ledger.service';
import { MarketViewService } from './market-view.service';
import { TRADING_CONFIG, type TradingConfig } from './trading-config';
import { TradingRegistryService } from './trading-registry.service';
import type { AccountRow, PositionRow } from './trading.types';
import { num } from './trading.types';

const decimal = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'Use a positive decimal number');

export const AccountSettingsSchema = z
  .object({
    confirmMode: z.enum(CONFIRM_MODES).optional(),
    confirmNotionalAbove: decimal.optional(),
    confirmLossPctAbove: decimal.optional(),
    /** Only while the account has no fills (paper accounts). */
    baseCurrency: z.string().regex(CURRENCY_RE, 'Use an ISO 4217 code such as USD').optional(),
    riskLimits: z
      .object({
        maxOrderNotional: decimal.optional(),
        maxPositionNotional: decimal.optional(),
        maxLeverage: decimal.optional(),
        dailyLossLimit: decimal.optional(),
        weeklyLossLimit: decimal.optional(),
        maxOrdersPerMinute: z.number().int().min(1).max(100_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((s) => Object.keys(s).length > 0, 'Change at least one setting');
export type AccountSettingsPatch = z.infer<typeof AccountSettingsSchema>;

export interface Valuation {
  summary: AccountSummary;
  positions: Array<ValuedPosition & { row: PositionRow; quoteCcy: string; stale: boolean }>;
  dayStartEquity: Decimal;
  weekStartEquity: Decimal;
  dayPnl: Decimal;
  weekPnl: Decimal;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const weekStart = (ms: number) => {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return utcDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
};

/** Paper accounts: one per user, created on first use with SIMULATED starting cash. */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(TRADING_CONFIG) private readonly cfg: TradingConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly registry: TradingRegistryService,
    private readonly market: MarketViewService,
    private readonly fx: FxService,
  ) {}

  async ensure(userId: string): Promise<AccountRow> {
    const existing = await this.db.query<AccountRow>(
      `SELECT * FROM accounts WHERE user_id = $1 AND environment = 'PAPER'`,
      [userId],
    );
    if (existing[0]) return existing[0];
    return this.db.tx(async (c) => {
      const ins = await c.query<AccountRow>(
        `INSERT INTO accounts (user_id, environment, base_currency, starting_cash, cash)
         VALUES ($1, 'PAPER', $2, $3::numeric, 0) ON CONFLICT (user_id, environment) DO NOTHING RETURNING *`,
        [userId, this.cfg.baseCurrency, this.cfg.startingCash],
      );
      const row = ins.rows[0];
      if (!row) {
        const again = await c.query<AccountRow>(
          `SELECT * FROM accounts WHERE user_id = $1 AND environment = 'PAPER'`,
          [userId],
        );
        return again.rows[0]!;
      }
      await this.ledger.post(
        c,
        row.id,
        depositJournal(dec(this.cfg.startingCash), row.base_currency),
        { type: 'account', id: row.id },
      );
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'account.opened',
          entity: 'account',
          entityId: row.id,
          payload: {
            environment: 'PAPER',
            baseCurrency: row.base_currency,
            startingCash: this.cfg.startingCash,
            simulated: true,
          },
        },
        c,
      );
      return { ...row, cash: this.cfg.startingCash };
    });
  }

  async byId(accountId: string, c?: Queryable): Promise<AccountRow | null> {
    const r = await (c ?? this.db.pool).query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [
      accountId,
    ]);
    return r.rows[0] ?? null;
  }

  async lock(c: Queryable, accountId: string): Promise<AccountRow> {
    const r = await c.query<AccountRow>('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [
      accountId,
    ]);
    if (!r.rows[0])
      throw new NotFoundException({ error: 'not_found', message: 'Account not found' });
    return r.rows[0];
  }

  confirmSettings(a: AccountRow): ConfirmSettings {
    const s = a.settings as {
      confirmMode?: ConfirmSettings['mode'];
      confirmNotionalAbove?: string;
      confirmLossPctAbove?: string;
    };
    return {
      mode: s.confirmMode ?? 'above_thresholds',
      notionalAbove: dec(s.confirmNotionalAbove ?? '50000'),
      lossPctAbove: dec(s.confirmLossPctAbove ?? '1'),
    };
  }

  /** Platform limits, tightened (never loosened) by the account's own limits. */
  limits(a: AccountRow): RiskLimits {
    const d = this.cfg.riskDefaults;
    const own = a.risk_limits as Partial<RiskLimits>;
    const tighter = (p: string, o: string | undefined) =>
      o !== undefined && dec(o).lt(dec(p)) ? o : p;
    return {
      maxOrderNotional: tighter(d.maxOrderNotional, own.maxOrderNotional),
      maxPositionNotional: tighter(d.maxPositionNotional, own.maxPositionNotional),
      maxLeverage: tighter(d.maxLeverage, own.maxLeverage),
      dailyLossLimit: tighter(d.dailyLossLimit, own.dailyLossLimit),
      weeklyLossLimit: tighter(d.weeklyLossLimit, own.weeklyLossLimit),
      maxOrdersPerMinute: Math.min(
        d.maxOrdersPerMinute,
        own.maxOrdersPerMinute ?? d.maxOrdersPerMinute,
      ),
    };
  }

  async positions(accountId: string, c?: Queryable): Promise<PositionRow[]> {
    const r = await (c ?? this.db.pool).query<PositionRow>(
      'SELECT * FROM positions WHERE account_id = $1 AND qty <> 0 ORDER BY symbol',
      [accountId],
    );
    return r.rows;
  }

  /** Values the account in base currency from last quotes (stale quotes allowed, flagged). */
  async value(a: AccountRow, c?: Queryable, now = Date.now()): Promise<Valuation> {
    const rows = await this.positions(a.id, c);
    const quotes = await this.market.quotes(rows.map((r) => r.symbol));
    const positions: Valuation['positions'] = [];
    for (const row of rows) {
      const inst = await this.registry.get(row.symbol);
      const q = quotes.get(row.symbol);
      const qty = dec(row.qty);
      const rate = await this.fx.rate(inst.spec.quoteCcy, a.base_currency, now);
      positions.push({
        row,
        symbol: row.symbol,
        qty,
        avgPrice: dec(row.avg_price),
        mark: q ? markFor(qty, q.bid, q.ask) : null,
        multiplier: inst.multiplier,
        fxRate: rate?.rate ?? null,
        marginRate: this.registry.marginRate(inst.spec, a.margin_tier),
        quoteCcy: inst.spec.quoteCcy,
        stale: !q || q.stale || now - q.receivedTs > inst.staleAfterMs || !rate?.fresh,
      });
    }
    const summary = summarizeAccount(dec(a.cash), positions);
    const dayStartEquity = await this.periodStart(a.id, 'day', utcDate(now), summary.equity, c);
    const weekStartEquity = await this.periodStart(a.id, 'week', weekStart(now), summary.equity, c);
    return {
      summary,
      positions,
      dayStartEquity,
      weekStartEquity,
      dayPnl: summary.equity.sub(dayStartEquity),
      weekPnl: summary.equity.sub(weekStartEquity),
    };
  }

  /** Period-start equity per (account, period, start); written once, then served from memory. */
  private readonly periodCache = new Map<string, Decimal>();

  private async periodStart(
    accountId: string,
    period: 'day' | 'week',
    start: string,
    equity: Decimal,
    c?: Queryable,
  ): Promise<Decimal> {
    const key = `${accountId}:${period}:${start}`;
    const hit = this.periodCache.get(key);
    if (hit) return hit;
    const q = c ?? this.db.pool;
    const r = await q.query<{ equity: string }>(
      `INSERT INTO account_equity_snapshots (account_id, period, period_start, equity) VALUES ($1, $2, $3::date, $4::numeric)
       ON CONFLICT (account_id, period, period_start) DO UPDATE SET equity = account_equity_snapshots.equity
       RETURNING equity::text AS equity`,
      [accountId, period, start, equity.toFixed()],
    );
    const v = dec(r.rows[0]!.equity);
    if (this.periodCache.size > 50_000) this.periodCache.clear();
    this.periodCache.set(key, v);
    return v;
  }

  /** Wire view of the account for GET /accounts/me and the `account:{id}` channel. */
  async view(a: AccountRow, c?: Queryable) {
    const v = await this.value(a, c);
    const ccy = a.base_currency;
    const m = (d: Decimal) => formatAmount(d, ccy);
    const limits = this.limits(a);
    const dailyLoss = v.dayPnl.isNegative() ? v.dayPnl.neg() : dec(0);
    return {
      id: a.id,
      environment: a.environment,
      simulated: true,
      baseCurrency: ccy,
      marginTier: a.margin_tier,
      status: a.status,
      startingCash: m(dec(a.starting_cash)),
      cash: m(v.summary.cash),
      equity: m(v.summary.equity),
      unrealizedPnl: m(v.summary.unrealizedPnl),
      dayPnl: m(v.dayPnl),
      weekPnl: m(v.weekPnl),
      marginUsed: m(v.summary.marginUsed),
      marginFree: m(v.summary.marginFree),
      marginUsedPct: v.summary.equity.gt(0)
        ? formatPct(v.summary.marginUsed.div(v.summary.equity))
        : '0.00',
      grossExposure: m(v.summary.grossExposure),
      leverage: v.summary.leverage.toDecimalPlaces(2).toFixed(2),
      dailyLossLimit: m(dec(limits.dailyLossLimit)),
      dailyLossUsedPct: formatPct(dailyLoss.div(dec(limits.dailyLossLimit))),
      openPositions: v.positions.length,
      unpriced: v.summary.unpriced,
      halt: {
        halted: a.trading_halted,
        scope: a.halt_scope,
        haltedAt: a.halted_at?.toISOString() ?? null,
        haltedBy: a.halted_by,
        reason: a.halt_reason,
      },
      limits,
      settings: { ...this.confirmSettingsView(a) },
      asOf: new Date().toISOString(),
    };
  }

  /** Positions with marks and base-currency P&L for GET /positions and `positions:{id}`. */
  async positionsView(a: AccountRow, c?: Queryable): Promise<PositionDto[]> {
    const v = await this.value(a, c);
    const ccy = a.base_currency;
    return v.positions.map((p) => {
      const fx = p.fxRate;
      const unreal =
        p.mark && fx ? p.mark.sub(p.avgPrice).mul(p.qty).mul(p.multiplier).mul(fx) : null;
      const exposure = p.mark && fx ? p.qty.abs().mul(p.mark).mul(p.multiplier).mul(fx) : null;
      return {
        accountId: a.id,
        symbol: p.symbol,
        qty: num(p.row.qty),
        avgPrice: num(p.row.avg_price),
        markPrice: p.mark ? p.mark.toFixed() : null,
        quoteCcy: p.quoteCcy,
        unrealizedPnl: unreal ? formatAmount(unreal, ccy) : null,
        realizedPnl: formatAmount(dec(p.row.realized_pnl), ccy),
        notional: exposure ? formatAmount(exposure, ccy) : null,
        marginUsed: exposure ? formatAmount(exposure.mul(p.marginRate), ccy) : null,
        updatedAt: p.row.updated_at.toISOString(),
        stale: p.stale,
      };
    });
  }

  private confirmSettingsView(a: AccountRow) {
    const s = this.confirmSettings(a);
    return {
      confirmMode: s.mode,
      confirmNotionalAbove: num(s.notionalAbove.toFixed()),
      confirmLossPctAbove: num(s.lossPctAbove.toFixed()),
    };
  }

  async updateSettings(userId: string, patch: AccountSettingsPatch): Promise<AccountRow> {
    const acct = await this.ensure(userId);
    return this.db.tx(async (c) => {
      const a = await this.lock(c, acct.id);
      const settings = { ...a.settings };
      if (patch.confirmMode) settings.confirmMode = patch.confirmMode;
      if (patch.confirmNotionalAbove) settings.confirmNotionalAbove = patch.confirmNotionalAbove;
      if (patch.confirmLossPctAbove) settings.confirmLossPctAbove = patch.confirmLossPctAbove;
      const riskLimits = { ...a.risk_limits, ...(patch.riskLimits ?? {}) };
      let base = a.base_currency;
      if (patch.baseCurrency && patch.baseCurrency !== a.base_currency) {
        const fills = await c.query('SELECT 1 FROM fills WHERE account_id = $1 LIMIT 1', [a.id]);
        const open = await c.query(
          `SELECT 1 FROM orders WHERE account_id = $1 AND status IN ('new','accepted','working','partially_filled') LIMIT 1`,
          [a.id],
        );
        if (fills.rowCount || open.rowCount) {
          throw new ConflictException({
            error: 'account_has_activity',
            message:
              'The account currency can only change before the first order is filled or placed.',
          });
        }
        base = patch.baseCurrency;
      }
      const r = await c.query<AccountRow>(
        'UPDATE accounts SET settings = $2::jsonb, risk_limits = $3::jsonb, base_currency = $4, updated_at = now() WHERE id = $1 RETURNING *',
        [a.id, JSON.stringify(settings), JSON.stringify(riskLimits), base],
      );
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'account.settings_updated',
          entity: 'account',
          entityId: a.id,
          payload: JSON.parse(
            JSON.stringify({ changed: patch, previousBaseCurrency: a.base_currency }),
          ) as Record<string, never>,
        },
        c,
      );
      return r.rows[0]!;
    });
  }
}
