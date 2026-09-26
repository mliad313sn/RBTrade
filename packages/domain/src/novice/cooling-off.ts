import { Decimal, dec } from '../decimal.js';
import type { CoolingOffReason } from '../trading/risk.js';

/**
 * Cooling-off for guarded (Novice) accounts (goal 08 §4). After too many losing trades in a day, a
 * large loss for the day, or the daily loss limit, new exposure waits until the next day. Closing
 * is always allowed. Thresholds are SIMULATED placeholders pending Compliance (OQ-R5).
 */
export interface CoolingOffThresholds {
  losingTrades: number;
  /** Day loss in % of the day-start balance. */
  dailyLossPct: string;
}

export const DEFAULT_COOLING_OFF: CoolingOffThresholds = { losingTrades: 3, dailyLossPct: '5' };

export interface CoolingOffInput {
  /** Closing orders today whose realised P&L net of fees is below zero. */
  losingTradesToday: number;
  dayPnl: Decimal;
  dayStartEquity: Decimal;
  dailyLossLimit: string;
}

export interface CoolingOffState {
  active: boolean;
  reason: CoolingOffReason | null;
  losingTradesToday: number;
  /** Day loss in % of the day-start balance (0 when up), two decimals. */
  dayLossPct: string;
}

export function coolingOff(
  i: CoolingOffInput,
  t: CoolingOffThresholds = DEFAULT_COOLING_OFF,
): CoolingOffState {
  const loss = i.dayPnl.isNegative() ? i.dayPnl.neg() : new Decimal(0);
  const pct = i.dayStartEquity.gt(0) ? loss.div(i.dayStartEquity).mul(100) : new Decimal(0);
  let reason: CoolingOffReason | null = null;
  if (loss.gt(0) && loss.gte(dec(i.dailyLossLimit))) reason = 'daily_loss_limit';
  else if (pct.gte(dec(t.dailyLossPct))) reason = 'daily_loss_pct';
  else if (i.losingTradesToday >= t.losingTrades) reason = 'losing_trades';
  return {
    active: reason !== null,
    reason,
    losingTradesToday: i.losingTradesToday,
    dayLossPct: pct.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2),
  };
}

/** Start of the next UTC day (when a cooling-off ends; the customer's time zone is B-308). */
export function nextUtcDay(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}
