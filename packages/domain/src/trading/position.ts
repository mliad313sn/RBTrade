import { dec, type Decimal } from '../decimal.js';
import { ZERO } from './money.js';
import { sideSign, type Side } from './orders.js';

/**
 * Net position with average-cost accounting. Quantities are signed (long > 0). Realised P&L is in
 * the instrument's quote currency: closed qty × (exit − average) × direction × multiplier.
 */
export interface PositionState {
  qty: Decimal;
  avgPrice: Decimal;
}

export interface SignedFill {
  side: Side;
  qty: Decimal;
  price: Decimal;
}

export interface ApplyFillResult {
  position: PositionState;
  /** Quantity that closed existing exposure (≥ 0). */
  closedQty: Decimal;
  /** Quantity that opened or increased exposure (≥ 0). */
  openedQty: Decimal;
  /** Realised P&L in quote currency (already × multiplier). */
  realizedPnl: Decimal;
}

export const FLAT: PositionState = { qty: ZERO, avgPrice: ZERO };

export function applyFill(
  pos: PositionState,
  fill: SignedFill,
  multiplier: Decimal,
): ApplyFillResult {
  if (fill.qty.lte(0)) throw new RangeError('fill qty must be > 0');
  const signed = fill.qty.mul(sideSign(fill.side));
  const q = pos.qty;
  // Same direction (or flat): increase with a weighted average.
  if (q.isZero() || q.isPositive() === signed.isPositive()) {
    const newQty = q.add(signed);
    const avg = q.isZero()
      ? fill.price
      : q.abs().mul(pos.avgPrice).add(fill.qty.mul(fill.price)).div(newQty.abs());
    return {
      position: { qty: newQty, avgPrice: avg },
      closedQty: ZERO,
      openedQty: fill.qty,
      realizedPnl: ZERO,
    };
  }
  // Opposite direction: close up to |q|, open the remainder at the fill price.
  const closedQty = Decimal_min(fill.qty, q.abs());
  const direction = q.isPositive() ? 1 : -1;
  const realizedPnl = closedQty.mul(fill.price.sub(pos.avgPrice)).mul(direction).mul(multiplier);
  const newQty = q.add(signed);
  const openedQty = fill.qty.sub(closedQty);
  let position: PositionState;
  if (newQty.isZero()) position = { qty: ZERO, avgPrice: ZERO };
  else if (openedQty.isZero()) position = { qty: newQty, avgPrice: pos.avgPrice };
  else position = { qty: newQty, avgPrice: fill.price };
  return { position, closedQty, openedQty, realizedPnl };
}

function Decimal_min(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

/** Unrealised P&L in quote currency at `mark`. */
export function unrealizedPnl(pos: PositionState, mark: Decimal, multiplier: Decimal): Decimal {
  if (pos.qty.isZero()) return ZERO;
  return mark.sub(pos.avgPrice).mul(pos.qty).mul(multiplier);
}

/** Replays fills from flat: the reconciliation source of truth. */
export function replayFills(
  fills: Iterable<SignedFill>,
  multiplier: Decimal,
): { position: PositionState; realizedPnl: Decimal } {
  let position = FLAT;
  let realized = ZERO;
  for (const f of fills) {
    const r = applyFill(position, f, multiplier);
    position = r.position;
    realized = realized.add(r.realizedPnl);
  }
  return { position, realizedPnl: realized };
}

/** Sum of signed fill quantities. */
export function signedQty(fills: Iterable<SignedFill>): Decimal {
  let s = ZERO;
  for (const f of fills) s = s.add(f.qty.mul(sideSign(f.side)));
  return s;
}

/** Exit price used to mark a position: the side you would trade to close it. */
export function markFor(qty: Decimal, bid: Decimal | string, ask: Decimal | string): Decimal {
  return qty.isNegative() ? dec(ask) : dec(bid);
}
