import { z } from 'zod';

import { dec, Decimal, DECIMAL_STRING, roundToTick } from './decimal.js';
import { SYMBOL_RE, type CalendarEvent, type InstrumentSpec } from './market-data.js';
import type { Side } from './trading/orders.js';

/**
 * Pro terminal (goal 04): request schemas for the per-user terminal state (layouts, watchlists,
 * alerts) and the ticket maths (units ↔ notional ↔ % equity, SL/TP in price ↔ pips ↔ %).
 * Every price and quantity is a Decimal rounded with the instrument registry.
 */

// ---- Layouts, watchlists, alerts ---------------------------------------------------------------

export const LAYOUT_NAME_RE = /^[\p{L}\p{N} ._-]{1,40}$/u;
export const MAX_LAYOUTS_PER_USER = 20;
export const MAX_LAYOUT_BYTES = 64 * 1024;

export const SaveLayoutSchema = z
  .object({
    /** dockview `toJSON()` output; opaque to the api apart from its size. */
    layout: z.record(z.string(), z.unknown()),
  })
  .strict();

export const MAX_WATCHLISTS_PER_USER = 20;
export const MAX_WATCHLIST_SYMBOLS = 500;
const watchlistName = z
  .string()
  .trim()
  .regex(LAYOUT_NAME_RE, 'Use up to 40 letters, digits, spaces, dot, dash or underscore');
const symbolList = z
  .array(z.string().regex(SYMBOL_RE))
  .max(MAX_WATCHLIST_SYMBOLS, `A watchlist holds at most ${MAX_WATCHLIST_SYMBOLS} symbols`)
  .refine((a) => new Set(a).size === a.length, 'Symbols must be unique');

export const CreateWatchlistSchema = z
  .object({ name: watchlistName, symbols: symbolList.default([]) })
  .strict();
export const UpdateWatchlistSchema = z
  .object({
    name: watchlistName.optional(),
    symbols: symbolList.optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export interface WatchlistDto {
  id: string;
  name: string;
  position: number;
  symbols: string[];
  updatedAt: string;
}

export const ALERT_CONDITIONS = ['price_above', 'price_below', 'rsi_above', 'rsi_below'] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];
export const ALERT_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;

export const CreateAlertSchema = z
  .object({
    symbol: z.string().regex(SYMBOL_RE),
    condition: z.enum(ALERT_CONDITIONS),
    threshold: z
      .string()
      .trim()
      .regex(DECIMAL_STRING)
      .refine((v) => !v.startsWith('-') && /[1-9]/.test(v), 'Must be greater than zero'),
    /** Indicator alerts only (RSI 14 on this timeframe). */
    timeframe: z.enum(ALERT_TIMEFRAMES).optional(),
    note: z.string().trim().max(120).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const indicator = a.condition.startsWith('rsi_');
    if (indicator && Number(a.threshold) >= 100)
      ctx.addIssue({ code: 'custom', path: ['threshold'], message: 'RSI is between 0 and 100' });
    if (!indicator && a.timeframe)
      ctx.addIssue({
        code: 'custom',
        path: ['timeframe'],
        message: 'Only indicator alerts take a timeframe',
      });
  });
export type CreateAlert = z.infer<typeof CreateAlertSchema>;

export interface PriceAlertDto {
  id: string;
  symbol: string;
  condition: AlertCondition;
  threshold: string;
  timeframe: string | null;
  note: string | null;
  status: 'active' | 'triggered' | 'cancelled';
  createdAt: string;
  triggeredAt: string | null;
  triggeredValue: string | null;
}

/** Pure trigger rule shared by the evaluator and its tests. */
export function alertTriggered(
  condition: AlertCondition,
  threshold: string,
  value: Decimal | number,
): boolean {
  const v = typeof value === 'number' ? new Decimal(value) : value;
  const t = dec(threshold);
  return condition.endsWith('_above') ? v.gte(t) : v.lte(t);
}

// ---- Ticket maths ---------------------------------------------------------------------------

export type QtyMode = 'units' | 'notional' | 'pct_equity';
export type DistanceMode = 'price' | 'pips' | 'percent';

/** One pip: the registry `pipSize`, or the tick size for instruments without pips. */
export function pipSizeOf(spec: Pick<InstrumentSpec, 'pipSize' | 'tickSize'>): Decimal {
  return dec(spec.pipSize ?? spec.tickSize);
}

/** Round a quantity down onto the registry grid (never up: the user asked for at most this much). */
export function roundQtyDown(qty: Decimal, qtyStep: string): Decimal {
  const step = dec(qtyStep);
  return qty.div(step).toDecimalPlaces(0, Decimal.ROUND_DOWN).mul(step);
}

/**
 * Units from the ticket's quantity field.
 * - `units`: as typed.
 * - `notional`: account-currency amount ÷ (price × multiplier × quote→account FX rate).
 * - `pct_equity`: notional = equity × pct / 100, then as above.
 * Returns null when the inputs are incomplete.
 */
export function unitsFromQtyInput(i: {
  mode: QtyMode;
  value: string;
  price: string | null;
  multiplier: string;
  qtyStep: string;
  equity?: string | null;
  /** Quote currency → account currency; "1" when they match. */
  fxRate?: string | null;
}): Decimal | null {
  if (!i.value || !DECIMAL_STRING.test(i.value)) return null;
  const v = dec(i.value);
  if (v.lte(0)) return null;
  if (i.mode === 'units') return roundQtyDown(v, i.qtyStep);
  if (!i.price) return null;
  const perUnit = dec(i.price)
    .mul(dec(i.multiplier))
    .mul(dec(i.fxRate ?? '1'));
  if (perUnit.lte(0)) return null;
  let notional = v;
  if (i.mode === 'pct_equity') {
    if (!i.equity) return null;
    notional = dec(i.equity).mul(v).div(100);
  }
  return roundQtyDown(notional.div(perUnit), i.qtyStep);
}

/**
 * Stop-loss / take-profit price from a distance typed in price, pips or % of the entry.
 * A stop sits against the position (below the entry for a buy); a target sits with it.
 */
export function protectivePrice(i: {
  kind: 'sl' | 'tp';
  mode: DistanceMode;
  value: string;
  side: Side;
  entry: string | null;
  spec: Pick<InstrumentSpec, 'pipSize' | 'tickSize'>;
}): Decimal | null {
  if (!i.value || !DECIMAL_STRING.test(i.value)) return null;
  const v = dec(i.value);
  if (v.lte(0)) return null;
  if (i.mode === 'price') return roundToTick(v, i.spec.tickSize);
  if (!i.entry) return null;
  const entry = dec(i.entry);
  const distance = i.mode === 'pips' ? v.mul(pipSizeOf(i.spec)) : entry.mul(v).div(100);
  const up = (i.side === 'buy') === (i.kind === 'tp');
  const p = up ? entry.add(distance) : entry.sub(distance);
  if (p.lte(0)) return null;
  return roundToTick(p, i.spec.tickSize);
}

/** Distance between two prices in pips (for labels such as "20.0 pips"). */
export function pipsBetween(
  a: string,
  b: string,
  spec: Pick<InstrumentSpec, 'pipSize' | 'tickSize'>,
): Decimal {
  return dec(a).sub(dec(b)).abs().div(pipSizeOf(spec));
}

export interface TicketWarning {
  code: 'RISK_ABOVE_RULE' | 'EVENT_SOON' | 'SESSION_NOT_OPEN' | 'DATA_NOT_OK' | 'NO_STOP';
  message: string;
}

/** Inline ticket warnings (goal 04 §5). They inform; the server's risk engine decides. */
export function ticketWarnings(i: {
  lossPctEquity: string | null;
  perTradeRiskPct: string;
  hasStop: boolean;
  events: readonly Pick<CalendarEvent, 'time' | 'currency' | 'title' | 'impact'>[];
  currencies: readonly string[];
  now: number;
  session: string | null;
  dataState: string | null;
  windowMinutes?: number;
}): TicketWarning[] {
  const out: TicketWarning[] = [];
  if (i.lossPctEquity !== null && dec(i.lossPctEquity).gt(dec(i.perTradeRiskPct))) {
    out.push({
      code: 'RISK_ABOVE_RULE',
      message: `Risk ${i.lossPctEquity}% of equity is above your per-trade rule of ${i.perTradeRiskPct}%.`,
    });
  }
  if (!i.hasStop)
    out.push({ code: 'NO_STOP', message: 'No stop loss: the loss on this trade is not capped.' });
  const windowMs = (i.windowMinutes ?? 60) * 60_000;
  const soon = i.events
    .filter((e) => i.currencies.includes(e.currency))
    .map((e) => ({ e, at: Date.parse(e.time) }))
    .filter(({ at }) => at >= i.now && at - i.now <= windowMs)
    .sort((a, b) => a.at - b.at)[0];
  if (soon) {
    const mins = Math.max(1, Math.round((soon.at - i.now) / 60_000));
    out.push({
      code: 'EVENT_SOON',
      message: `${soon.e.currency} ${soon.e.title} in ${mins} min: spreads and slippage can widen.`,
    });
  }
  if (i.session && i.session !== 'open')
    out.push({
      code: 'SESSION_NOT_OPEN',
      message: `Market ${i.session === 'closed' ? 'closed' : i.session}: the order will wait for the session to open.`,
    });
  if (i.dataState && i.dataState !== 'ok')
    out.push({
      code: 'DATA_NOT_OK',
      message: `Market data ${i.dataState.replace('_', ' ')}: no fills until the feed is healthy.`,
    });
  return out;
}

/** Session badge text (B-208): "market closed" is not "stale". */
export function sessionBadge(state: string | null | undefined): {
  label: string;
  tone: 'open' | 'closed';
} {
  switch (state) {
    case 'open':
      return { label: 'Open', tone: 'open' };
    case 'break':
      return { label: 'Break', tone: 'closed' };
    case 'holiday':
      return { label: 'Holiday', tone: 'closed' };
    case 'closed':
      return { label: 'Closed', tone: 'closed' };
    default:
      return { label: 'Unknown', tone: 'closed' };
  }
}

/** Show the Stale badge only when the market is open; a closed market's last quote is simply old. */
export function quoteBadge(i: {
  stale: boolean;
  session: string | null | undefined;
}): 'stale' | 'closed' | null {
  if (i.session && i.session !== 'open') return 'closed';
  return i.stale ? 'stale' : null;
}
