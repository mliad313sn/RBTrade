import { Decimal, dec, roundToTick } from '../decimal.js';
import { currencyDecimals } from '../trading/money.js';
import type { Side } from '../trading/orders.js';
import { roundQtyDown } from '../terminal.js';

/**
 * Novice "Make a trade" (goal 08 §3): an amount in the account currency and a safety net in % become
 * a market order with a protective stop on the registry grid. The server builds the order with this
 * function and returns the `/orders/preview` answer for exactly that order, so "most you could lose"
 * is the preview's `lossIfStopHit.total` (price loss + fees), never a second calculation.
 */

export const NOVICE_DIRECTIONS = ['up', 'down'] as const;
export type NoviceDirection = (typeof NOVICE_DIRECTIONS)[number];

/** Safety net slider: % move against the trade before it closes automatically. */
export const SAFETY_NET = { min: 0.5, max: 10, step: 0.5, default: 3 } as const;

export const directionToSide = (d: NoviceDirection): Side => (d === 'up' ? 'buy' : 'sell');

export interface NoviceOrderInput {
  direction: NoviceDirection;
  /** Amount to put in, in the account currency (decimal string). */
  amount: string;
  /** Safety net distance in % of the entry price (decimal string). */
  safetyNetPct: string;
  bid: string;
  ask: string;
  tickSize: string;
  qtyStep: string;
  minQty: string;
  multiplier: string;
  /** Quote currency → account currency ("1" when they match). */
  fxRate: string;
  accountCcy: string;
}

export type NoviceOrderResult =
  | {
      ok: true;
      side: Side;
      qty: string;
      stopLossPrice: string;
      /** Touch price the quantity was sized on (ask for a buy, bid for a sell). */
      refPrice: string;
      /** Amount actually used (qty × price in the account currency), ≤ the amount asked. */
      amountUsed: string;
      minAmount: string;
    }
  | { ok: false; reason: 'amount_too_small' | 'invalid'; minAmount: string | null };

/** Smallest amount (account currency, rounded up to the minor unit) that buys the minimum quantity. */
export function minimumAmount(
  i: Pick<
    NoviceOrderInput,
    'bid' | 'ask' | 'direction' | 'minQty' | 'multiplier' | 'fxRate' | 'accountCcy'
  >,
): string {
  const ref = dec(i.direction === 'up' ? i.ask : i.bid);
  const v = dec(i.minQty).mul(ref).mul(dec(i.multiplier)).mul(dec(i.fxRate));
  const dp = currencyDecimals(i.accountCcy);
  return v.toDecimalPlaces(dp, Decimal.ROUND_UP).toFixed(dp);
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** Builds the novice market order (qty rounded down, stop rounded away from the entry). */
export function buildNoviceOrder(i: NoviceOrderInput): NoviceOrderResult {
  if (![i.amount, i.safetyNetPct, i.bid, i.ask, i.fxRate].every((x) => DECIMAL.test(x)))
    return { ok: false, reason: 'invalid', minAmount: null };
  const pct = dec(i.safetyNetPct);
  if (pct.lt(SAFETY_NET.min) || pct.gt(SAFETY_NET.max) || dec(i.bid).lte(0) || dec(i.ask).lte(0))
    return { ok: false, reason: 'invalid', minAmount: null };
  const side = directionToSide(i.direction);
  const ref = dec(side === 'buy' ? i.ask : i.bid);
  const perUnit = ref.mul(dec(i.multiplier)).mul(dec(i.fxRate));
  const minAmount = minimumAmount(i);
  if (perUnit.lte(0)) return { ok: false, reason: 'invalid', minAmount: null };
  const qty = roundQtyDown(dec(i.amount).div(perUnit), i.qtyStep);
  if (qty.lt(dec(i.minQty)) || qty.lte(0))
    return { ok: false, reason: 'amount_too_small', minAmount };
  const distance = ref.mul(pct).div(100);
  // Away from the entry: a buy's stop rounds down, a sell's rounds up (never tighter than asked).
  const stop =
    side === 'buy'
      ? roundToTick(ref.sub(distance), i.tickSize, Decimal.ROUND_FLOOR)
      : roundToTick(ref.add(distance), i.tickSize, Decimal.ROUND_CEIL);
  if (stop.lte(0)) return { ok: false, reason: 'invalid', minAmount };
  const dp = currencyDecimals(i.accountCcy);
  return {
    ok: true,
    side,
    qty: qty.toFixed(),
    stopLossPrice: stop.toFixed(),
    refPrice: ref.toFixed(),
    amountUsed: qty.mul(perUnit).toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed(dp),
    minAmount,
  };
}

/**
 * Review sheet gain scenario: if the price moves the same distance the other way, the gross gain
 * equals the gross loss at the stop (`lossIfStopHit.price`); fees still apply, so subtract the same
 * costs. Both inputs are preview strings in the account currency.
 */
export function scenarioGain(loss: { price: string; costs: string }, accountCcy: string): string {
  const dp = currencyDecimals(accountCcy);
  const g = dec(loss.price).sub(dec(loss.costs));
  return (g.isNegative() ? new Decimal(0) : g)
    .toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN)
    .toFixed(dp);
}

/** The preview's `lossIfStopHit` block (strings in the account currency). */
export interface LossAtStop {
  price: string;
  costs: string;
  total: string;
}

/**
 * The three numbers the Novice ticket shows, taken from the preview without recalculation:
 * "most you could lose" (`total`: price loss + all fees), "includes … in fees" (`costs`), and the
 * review sheet's gain scenario.
 */
export function noviceLossFigures(
  loss: LossAtStop | null | undefined,
  accountCcy: string,
): { mostYouCouldLose: string; fees: string; gain: string } | null {
  if (!loss) return null;
  return { mostYouCouldLose: loss.total, fees: loss.costs, gain: scenarioGain(loss, accountCcy) };
}
