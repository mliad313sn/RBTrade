import { Decimal, dec } from '../decimal.js';
import { notional } from './costs.js';
import { ZERO } from './money.js';

/**
 * Account valuation in base currency (goal 03 §1): equity = cash + unrealised P&L; margin used from
 * registry margin rates; leverage = gross exposure / equity.
 */
export interface ValuedPosition {
  symbol: string;
  qty: Decimal;
  avgPrice: Decimal;
  /** Exit-side price (bid for longs, ask for shorts); null when no quote exists yet. */
  mark: Decimal | null;
  multiplier: Decimal;
  /** Quote → base conversion rate; null when unavailable. */
  fxRate: Decimal | null;
  marginRate: Decimal;
}

export interface AccountSummary {
  cash: Decimal;
  unrealizedPnl: Decimal;
  equity: Decimal;
  grossExposure: Decimal;
  marginUsed: Decimal;
  marginFree: Decimal;
  /** Gross exposure / equity (0 when equity ≤ 0 and flat). */
  leverage: Decimal;
  /** Positions valued at their average price because a mark or FX rate is missing. */
  unpriced: string[];
}

export function valuePosition(p: ValuedPosition): {
  unrealized: Decimal;
  exposure: Decimal;
  margin: Decimal;
  priced: boolean;
} {
  if (p.qty.isZero()) return { unrealized: ZERO, exposure: ZERO, margin: ZERO, priced: true };
  const priced = p.mark !== null && p.fxRate !== null;
  const mark = p.mark ?? p.avgPrice;
  const fx = p.fxRate ?? new Decimal(1);
  const unrealized = priced ? mark.sub(p.avgPrice).mul(p.qty).mul(p.multiplier).mul(fx) : ZERO;
  const exposure = notional(p.qty, mark, p.multiplier).mul(fx);
  return { unrealized, exposure, margin: exposure.mul(p.marginRate), priced };
}

export function summarizeAccount(
  cash: Decimal,
  positions: readonly ValuedPosition[],
): AccountSummary {
  let unrealizedPnl = ZERO;
  let grossExposure = ZERO;
  let marginUsed = ZERO;
  const unpriced: string[] = [];
  for (const p of positions) {
    const v = valuePosition(p);
    unrealizedPnl = unrealizedPnl.add(v.unrealized);
    grossExposure = grossExposure.add(v.exposure);
    marginUsed = marginUsed.add(v.margin);
    if (!v.priced) unpriced.push(p.symbol);
  }
  const equity = cash.add(unrealizedPnl);
  return {
    cash,
    unrealizedPnl,
    equity,
    grossExposure,
    marginUsed,
    marginFree: equity.sub(marginUsed),
    leverage: equity.gt(0)
      ? grossExposure.div(equity)
      : grossExposure.isZero()
        ? ZERO
        : dec('999999'),
    unpriced,
  };
}
