import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  applyLimitChanges,
  CONFIRM_MODES,
  coolingOff,
  CURRENCY_RE,
  dec,
  effectiveOwnLimits,
  nextUtcDay,
  pendingChanges,
  type CoolingOffState,
  type GuardedLimitField,
  type StoredLimits,
  depositJournal,
  depositReversalJournal,
  formatAmount,
  formatPct,
  markFor,
  roundMoney,
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
/** IRTC R2-18: a limit of zero is not a limit (and divides by zero in the account view). */
const limitValue = decimal.refine((v) => /[1-9]/.test(v), 'A limit must be greater than zero');

/** Own-limit fields expressed in the account currency (converted when the currency changes). */
const MONEY_LIMIT_FIELDS = [
  'maxOrderNotional',
  'maxPositionNotional',
  'dailyLossLimit',
  'weeklyLossLimit',
  'monthlyLossLimit',
] as const;

export const AccountSettingsSchema = z
  .object({
    confirmMode: z.enum(CONFIRM_MODES).optional(),
    confirmNotionalAbove: decimal.optional(),
    confirmLossPctAbove: decimal.optional(),
    /** Only while the account has no fills (paper accounts). */
    baseCurrency: z.string().regex(CURRENCY_RE, 'Use an ISO 4217 code such as USD').optional(),
    riskLimits: z
      .object({
        maxOrderNotional: limitValue.optional(),
        maxPositionNotional: limitValue.optional(),
        maxLeverage: limitValue.optional(),
        dailyLossLimit: limitValue.optional(),
        weeklyLossLimit: limitValue.optional(),
        monthlyLossLimit: limitValue.optional(),
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
  monthStartEquity: Decimal;
  dayPnl: Decimal;
  weekPnl: Decimal;
  monthPnl: Decimal;
}

/** Guarded (Novice) state for the risk check and the Novice view (goal 08). */
export interface GuardState {
  coolingOff: CoolingOffState & { until: string | null };
  /** Borrowing cap as a multiple of equity: "1" = no leverage. */
  noviceMaxLeverage: string;
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const weekStart = (ms: number) => {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return utcDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
};
const monthStart = (ms: number) => utcDate(ms).slice(0, 8) + '01';
const dayStartMs = (ms: number) => Date.parse(`${utcDate(ms)}T00:00:00Z`);

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

  /**
   * Platform limits, tightened (never loosened) by the account's own limits in effect at `now`
   * (goal 08: a pending loosening applies itself once its wait is over).
   */
  limits(a: AccountRow, now = Date.now()): RiskLimits {
    const d = this.platformLimits(a);
    const own = effectiveOwnLimits(a.risk_limits as StoredLimits, now);
    const tighter = (p: string, o: string | undefined) =>
      o !== undefined && dec(o).lt(dec(p)) ? o : p;
    const monthly =
      d.monthlyLossLimit !== undefined
        ? tighter(d.monthlyLossLimit, own.monthlyLossLimit)
        : own.monthlyLossLimit;
    return {
      maxOrderNotional: tighter(d.maxOrderNotional, own.maxOrderNotional),
      maxPositionNotional: tighter(d.maxPositionNotional, own.maxPositionNotional),
      maxLeverage: tighter(d.maxLeverage, own.maxLeverage),
      dailyLossLimit: tighter(d.dailyLossLimit, own.dailyLossLimit),
      weeklyLossLimit: tighter(d.weeklyLossLimit, own.weeklyLossLimit),
      maxOrdersPerMinute: Math.min(
        d.maxOrdersPerMinute,
        own.maxOrdersPerMinute !== undefined
          ? Number(own.maxOrdersPerMinute)
          : d.maxOrdersPerMinute,
      ),
      ...(monthly !== undefined ? { monthlyLossLimit: monthly } : {}),
    };
  }

  /**
   * The platform ceiling for this account: the configured defaults, raised only by an approved
   * four-eyes override (goal 09). Overrides never lower a limit (the account's own limits do that).
   */
  platformLimits(a: AccountRow): TradingConfig['riskDefaults'] {
    const d = this.platformDefaults(a);
    const o = a.limit_overrides ?? {};
    const higher = (p: string, v: string | undefined) => (v !== undefined && dec(v).gt(dec(p)) ? v : p);
    return {
      ...d,
      maxOrderNotional: higher(d.maxOrderNotional, o.maxOrderNotional),
      maxPositionNotional: higher(d.maxPositionNotional, o.maxPositionNotional),
      maxLeverage: higher(d.maxLeverage, o.maxLeverage),
      dailyLossLimit: higher(d.dailyLossLimit, o.dailyLossLimit),
      weeklyLossLimit: higher(d.weeklyLossLimit, o.weeklyLossLimit),
      maxOrdersPerMinute:
        o.maxOrdersPerMinute !== undefined && Number(o.maxOrdersPerMinute) > d.maxOrdersPerMinute
          ? Number(o.maxOrdersPerMinute)
          : d.maxOrdersPerMinute,
    };
  }

  /**
   * IRTC R2-05: the platform defaults are set in the platform currency (`KORA_PAPER_BASE_CURRENCY`).
   * An account in another currency gets them converted at the rate recorded when it chose that
   * currency (`settings.limitFx`), so a limit keeps its value whatever the account currency.
   */
  private platformDefaults(a: AccountRow): TradingConfig['riskDefaults'] {
    const d = this.cfg.riskDefaults;
    const fx = (a.settings as { limitFx?: { to?: string; rate?: string } }).limitFx;
    if (a.base_currency === this.cfg.baseCurrency || !fx?.rate || fx.to !== a.base_currency) return d;
    const rate = dec(fx.rate);
    const conv = (v: string) => roundMoney(dec(v).mul(rate), a.base_currency).toFixed();
    return {
      ...d,
      maxOrderNotional: conv(d.maxOrderNotional),
      maxPositionNotional: conv(d.maxPositionNotional),
      dailyLossLimit: conv(d.dailyLossLimit),
      weeklyLossLimit: conv(d.weeklyLossLimit),
      monthlyLossLimit: d.monthlyLossLimit !== undefined ? conv(d.monthlyLossLimit) : undefined,
    };
  }

  /**
   * IRTC R2-08: records the day/week/month start equity of every active account at the period
   * boundary (called by the engine loop's sweep), so a loss taken before the account's first request
   * of the day still counts against the daily loss limit and the Novice cooling-off.
   */
  async snapshotPeriodStarts(now = Date.now()): Promise<number> {
    const rows = await this.db.query<AccountRow>(
      `SELECT a.* FROM accounts a
       WHERE (EXISTS (SELECT 1 FROM positions p WHERE p.account_id = a.id AND p.qty <> 0)
           OR EXISTS (SELECT 1 FROM orders o WHERE o.account_id = a.id AND o.status IN ('working', 'partially_filled')))
         AND NOT EXISTS (SELECT 1 FROM account_equity_snapshots s WHERE s.account_id = a.id AND s.period = 'day' AND s.period_start = $1::date)`,
      [utcDate(now)],
    );
    for (const a of rows) await this.value(a, undefined, now);
    return rows.length;
  }

  /** Novice borrowing cap in effect ("1" = off), never above the configured novice maximum. */
  noviceMaxLeverage(a: AccountRow, now = Date.now()): string {
    const own = effectiveOwnLimits(a.risk_limits as StoredLimits, now).noviceMaxLeverage;
    if (own === undefined || dec(own).lte(1)) return '1';
    const cap = this.cfg.novice.maxLeverage;
    return dec(own).gt(dec(cap)) ? cap : own;
  }

  /** Closing orders today (UTC) whose realised P&L net of fees is below zero. */
  async losingTradesToday(accountId: string, now = Date.now(), c?: Queryable): Promise<number> {
    const r = await (c ?? this.db.pool).query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT order_id FROM fills WHERE account_id = $1 AND ts >= $2 AND realized_pnl <> 0
         GROUP BY order_id HAVING sum(realized_pnl - commission - fx_conversion_cost) < 0) x`,
      [accountId, new Date(dayStartMs(now))],
    );
    return Number(r.rows[0]!.n);
  }

  /** Cooling-off and borrowing cap for a guarded account (goal 08 §4). */
  async guardState(
    a: AccountRow,
    v: Valuation,
    now = Date.now(),
    c?: Queryable,
  ): Promise<GuardState> {
    const state = coolingOff(
      {
        losingTradesToday: await this.losingTradesToday(a.id, now, c),
        dayPnl: v.dayPnl,
        dayStartEquity: v.dayStartEquity,
        dailyLossLimit: this.limits(a, now).dailyLossLimit,
      },
      this.cfg.novice.coolingOff,
    );
    return {
      coolingOff: { ...state, until: state.active ? nextUtcDay(now) : null },
      noviceMaxLeverage: this.noviceMaxLeverage(a, now),
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
    const monthStartEquity = await this.periodStart(
      a.id,
      'month',
      monthStart(now),
      summary.equity,
      c,
    );
    return {
      summary,
      positions,
      dayStartEquity,
      weekStartEquity,
      monthStartEquity,
      dayPnl: summary.equity.sub(dayStartEquity),
      weekPnl: summary.equity.sub(weekStartEquity),
      monthPnl: summary.equity.sub(monthStartEquity),
    };
  }

  /** Period-start equity per (account, period, start); written once, then served from memory. */
  private readonly periodCache = new Map<string, Decimal>();

  private async periodStart(
    accountId: string,
    period: 'day' | 'week' | 'month',
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
  async view(a: AccountRow, c?: Queryable, valued?: Awaited<ReturnType<AccountsService['value']>>) {
    const v = valued ?? (await this.value(a, c));
    const ccy = a.base_currency;
    const m = (d: Decimal) => formatAmount(d, ccy);
    const now = Date.now();
    const limits = this.limits(a, now);
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
      monthPnl: m(v.monthPnl),
      marginUsed: m(v.summary.marginUsed),
      marginFree: m(v.summary.marginFree),
      marginUsedPct: v.summary.equity.gt(0)
        ? formatPct(v.summary.marginUsed.div(v.summary.equity))
        : '0.00',
      grossExposure: m(v.summary.grossExposure),
      leverage: v.summary.leverage.toDecimalPlaces(2).toFixed(2),
      dailyLossLimit: m(dec(limits.dailyLossLimit)),
      dailyLossUsedPct: dec(limits.dailyLossLimit).gt(0)
        ? formatPct(dailyLoss.div(dec(limits.dailyLossLimit)))
        : dailyLoss.gt(0)
          ? '100.00'
          : '0.00',
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
      /** Goal 08: loosened limits waiting for their 24 h (guarded accounts). */
      pendingLimits: pendingChanges(a.risk_limits as StoredLimits, now),
      noviceMaxLeverage: this.noviceMaxLeverage(a, now),
      settings: { ...this.confirmSettingsView(a) },
      asOf: new Date().toISOString(),
    };
  }

  /** Positions with marks and base-currency P&L for GET /positions and `positions:{id}`. */
  async positionsView(a: AccountRow, c?: Queryable, valued?: Awaited<ReturnType<AccountsService['value']>>): Promise<PositionDto[]> {
    const v = valued ?? (await this.value(a, c));
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

  /**
   * Settings and own risk limits. `guarded` (novice-only users and anyone in the Novice view):
   * tightening applies now, loosening waits `KORA_NOVICE_LOOSEN_DELAY_HOURS` (goal 08 §4).
   * `extraLimits` carries server-only fields (the novice borrowing cap, set by /novice/leverage).
   */
  async updateSettings(
    userId: string,
    patch: AccountSettingsPatch,
    opts: {
      guarded?: boolean;
      extraLimits?: Partial<Record<GuardedLimitField, string>>;
    } = {},
  ): Promise<AccountRow> {
    const acct = await this.ensure(userId);
    return this.db.tx(async (c) => {
      const a = await this.lock(c, acct.id);
      const settings = { ...a.settings };
      if (patch.confirmMode) settings.confirmMode = patch.confirmMode;
      if (patch.confirmNotionalAbove) settings.confirmNotionalAbove = patch.confirmNotionalAbove;
      if (patch.confirmLossPctAbove) settings.confirmLossPctAbove = patch.confirmLossPctAbove;
      const now = Date.now();
      let base = a.base_currency;
      let startingCash = a.starting_cash;
      let storedLimits = a.risk_limits as StoredLimits;
      let conversion: Record<string, string> | null = null;
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
        // IRTC R2-05: convert, never relabel. The SIMULATED balance is moved to the new currency
        // at the current rate (reversal + deposit, both journals in their own currency) and the
        // own limits are converted with it; the platform limits follow via `settings.limitFx`.
        const rate = await this.fx.rate(a.base_currency, base, now);
        const platformRate =
          base === this.cfg.baseCurrency ? null : await this.fx.rate(this.cfg.baseCurrency, base, now);
        if (!rate || (base !== this.cfg.baseCurrency && !platformRate))
          throw new ConflictException({
            error: 'fx_unavailable',
            message: `No exchange rate from ${a.base_currency} to ${base} is available, so the balance cannot be converted. Try again later.`,
          });
        const cashBefore = dec(a.cash);
        const cashAfter = roundMoney(cashBefore.mul(rate.rate), base);
        await this.ledger.post(c, a.id, depositReversalJournal(cashBefore, a.base_currency), {
          type: 'account',
          id: a.id,
        });
        await this.ledger.post(c, a.id, depositJournal(cashAfter, base), { type: 'account', id: a.id });
        startingCash = roundMoney(dec(a.starting_cash).mul(rate.rate), base).toFixed();
        storedLimits = convertOwnLimits(storedLimits, rate.rate, base);
        if (platformRate)
          settings.limitFx = { from: this.cfg.baseCurrency, to: base, rate: platformRate.rate.toFixed() };
        else delete settings.limitFx;
        conversion = {
          from: a.base_currency,
          to: base,
          rate: rate.rate.toFixed(),
          rateFresh: String(rate.fresh),
          cashBefore: cashBefore.toFixed(),
          cashAfter: cashAfter.toFixed(),
        };
      }
      const converted: AccountRow = { ...a, base_currency: base, settings, risk_limits: storedLimits };
      const eff = this.limits(converted, now);
      const requested = { ...(patch.riskLimits ?? {}), ...(opts.extraLimits ?? {}) };
      const change = applyLimitChanges(
        storedLimits,
        requested,
        (f) =>
          f === 'noviceMaxLeverage'
            ? this.noviceMaxLeverage(converted, now)
            : f === 'maxOrdersPerMinute'
              ? String(eff.maxOrdersPerMinute)
              : (eff as unknown as Record<string, string | undefined>)[f],
        now,
        opts.guarded ? this.cfg.novice.loosenDelayMs : 0,
      );
      const riskLimits = change.stored;
      const r = await c.query<AccountRow>(
        'UPDATE accounts SET settings = $2::jsonb, risk_limits = $3::jsonb, base_currency = $4, starting_cash = $5::numeric, updated_at = now() WHERE id = $1 RETURNING *',
        [a.id, JSON.stringify(settings), JSON.stringify(riskLimits), base, startingCash],
      );
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'account.settings_updated',
          entity: 'account',
          entityId: a.id,
          payload: JSON.parse(
            JSON.stringify({
              changed: patch,
              previousBaseCurrency: a.base_currency,
              currencyConversion: conversion,
              guarded: !!opts.guarded,
              limitsApplied: change.applied,
              limitsPending: change.pending,
            }),
          ) as Record<string, never>,
        },
        c,
      );
      return r.rows[0]!;
    });
  }
}

/** Own money limits (and pending loosenings) converted to a new account currency (IRTC R2-05). */
function convertOwnLimits(stored: StoredLimits, rate: Decimal, ccy: string): StoredLimits {
  if (!stored) return stored;
  const conv = (v: unknown): unknown =>
    typeof v === 'string' || typeof v === 'number'
      ? roundMoney(dec(String(v)).mul(rate), ccy).toFixed()
      : v;
  const out: StoredLimits = { ...stored };
  for (const f of MONEY_LIMIT_FIELDS) if (out[f] !== undefined) out[f] = conv(out[f]);
  if (stored.pending) {
    const pending = { ...stored.pending } as Record<string, { value: string; effectiveAt: string }>;
    for (const f of MONEY_LIMIT_FIELDS)
      if (pending[f]) pending[f] = { ...pending[f], value: conv(pending[f].value) as string };
    out.pending = pending as StoredLimits['pending'];
  }
  return out;
}
