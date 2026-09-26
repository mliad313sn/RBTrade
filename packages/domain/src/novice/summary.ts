import { Decimal, dec } from '../decimal.js';
import { currencyDecimals } from '../trading/money.js';

/**
 * Novice home numbers (goal 08 §2): change since start and the worst dip so far, from a balance
 * series (daily snapshots plus now). Pure, so the UI numbers trace to a tested calculation.
 */
export interface EquityPoint {
  t: string;
  equity: string;
}

export interface WorstDip {
  /** Largest fall from a previous high, as a positive amount in the account currency. */
  amount: string;
  /** The same fall in % of that high, two decimals. */
  pct: string;
  /** When the low of that fall happened (null when there was no fall). */
  at: string | null;
}

export function worstDip(series: EquityPoint[], ccy: string): WorstDip {
  const dp = currencyDecimals(ccy);
  let peak: Decimal | null = null;
  let worst = new Decimal(0);
  let worstPct = new Decimal(0);
  let at: string | null = null;
  for (const p of series) {
    const e = dec(p.equity);
    if (peak === null || e.gt(peak)) peak = e;
    const fall = peak.sub(e);
    if (fall.gt(worst)) {
      worst = fall;
      worstPct = peak.gt(0) ? fall.div(peak).mul(100) : new Decimal(0);
      at = p.t;
    }
  }
  return {
    amount: worst.toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed(dp),
    pct: worstPct.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2),
    at,
  };
}

export interface ChangeSinceStart {
  amount: string;
  pct: string;
}

export function changeSinceStart(start: string, now: string, ccy: string): ChangeSinceStart {
  const dp = currencyDecimals(ccy);
  const s = dec(start);
  const d = dec(now).sub(s);
  return {
    amount: d.toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed(dp),
    pct: s.gt(0)
      ? d.div(s).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2)
      : '0.00',
  };
}

/** Suggested loss limit from a % of the balance, rounded down to a whole currency unit. */
export function suggestedLimit(balance: string, pct: string): string {
  const v = dec(balance).mul(dec(pct)).div(100).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
  return (v.lt(1) ? new Decimal(1) : v).toFixed(0);
}
