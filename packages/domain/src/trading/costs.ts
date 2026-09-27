import { Decimal, dec } from '../decimal.js';
import type { AssetClass, DepthLevel, InstrumentSpec } from '../market-data.js';
import { roundMoney, ZERO } from './money.js';
import type { Side } from './orders.js';

/**
 * Registry-driven cost and execution parameters (goal 03 + scope amendment). Every value comes from
 * the `fee_schedules` and `asset_class_trading` registry tables; all seeded rows are SIMULATED
 * placeholders (OQ-M1, OQ-B1). No asset class is special-cased in code.
 */

export const MULTIPLIER_MODES = ['unit', 'contract', 'percent_of_par'] as const;
export type MultiplierMode = (typeof MULTIPLIER_MODES)[number];

export interface FeeSchedule {
  id: string;
  /** Commission in basis points of notional (quote currency). */
  commissionBps: string;
  /** Commission per unit of qty (quote currency), e.g. per share or per contract. */
  commissionPerUnit: string;
  /** Minimum commission per fill (quote currency). */
  commissionMin: string;
  /** Annual overnight funding rate in bps of notional, signed from the customer's view (charge < 0). */
  swapLongBps: string;
  swapShortBps: string;
  /** Currency conversion fee in bps, charged when a cash flow is converted to the account currency. */
  fxConversionBps: string;
  simulated: boolean;
}

export interface AssetClassTrading {
  assetClass: AssetClass;
  multiplierMode: MultiplierMode;
  /** Fat-finger band: max distance of a limit/stop price from mid, in percent. */
  fatFingerPct: string;
  /** Extra ticks of impact for each depth level beyond the top of book. */
  impactTicks: string;
  /** Share of the last mid move added against the taker (volatility term). */
  volFactor: string;
  /** Depth levels the paper engine may consume in one matching pass. */
  maxLevels: number;
  simulated: boolean;
}

export type TradingSpec = Pick<
  InstrumentSpec,
  | 'symbol'
  | 'assetClass'
  | 'quoteCcy'
  | 'tickSize'
  | 'pricePrecision'
  | 'contractSize'
  | 'marginRates'
  | 'qtyStep'
  | 'minQty'
  | 'qtyPrecision'
>;

/**
 * Value of one price point per unit of qty, in quote currency. B-202: instruments quoted in a minor
 * unit (GBX, ZAc) multiply by `priceUnitFactor` (0.01), so notional and P&L land in the major currency.
 */
export function priceMultiplier(
  spec: Pick<InstrumentSpec, 'contractSize'> & Partial<Pick<InstrumentSpec, 'priceUnitFactor'>>,
  mode: MultiplierMode,
): Decimal {
  const base =
    mode === 'unit' ? new Decimal(1) : mode === 'contract' ? dec(spec.contractSize) : new Decimal('0.01');
  return spec.priceUnitFactor ? base.mul(dec(spec.priceUnitFactor)) : base;
}

/** Notional in quote currency. */
export function notional(qty: Decimal, price: Decimal, multiplier: Decimal): Decimal {
  return qty.abs().mul(price).mul(multiplier);
}

/** Commission before the minimum and before rounding (quote currency). */
export function commissionRaw(
  fs: FeeSchedule,
  qty: Decimal,
  price: Decimal,
  multiplier: Decimal,
): Decimal {
  return notional(qty, price, multiplier)
    .mul(dec(fs.commissionBps))
    .div(10_000)
    .add(qty.abs().mul(dec(fs.commissionPerUnit)));
}

/** Commission of a whole order from its raw total: minimum applied once, rounded to the minor unit. */
export function orderCommission(fs: FeeSchedule, raw: Decimal, quoteCcy: string): Decimal {
  const min = dec(fs.commissionMin);
  return roundMoney(raw.lt(min) ? min : raw, quoteCcy);
}

/** Commission for one order filled in one piece, in quote currency, rounded to the minor unit. */
export function commission(
  fs: FeeSchedule,
  qty: Decimal,
  price: Decimal,
  multiplier: Decimal,
  quoteCcy: string,
): Decimal {
  return orderCommission(fs, commissionRaw(fs, qty, price, multiplier), quoteCcy);
}

/**
 * IRTC R2-06: commission for the next fill of an order that already received fills with a raw
 * commission of `rawBefore`. The minimum applies once per order (as the preview shows), so the fills
 * of an order always add up to `orderCommission` of the order's total, however many depth levels or
 * partial fills it takes.
 */
export function incrementalCommission(
  fs: FeeSchedule,
  rawBefore: Decimal,
  hadFills: boolean,
  qty: Decimal,
  price: Decimal,
  multiplier: Decimal,
  quoteCcy: string,
): Decimal {
  const charged = hadFills ? orderCommission(fs, rawBefore, quoteCcy) : ZERO;
  const total = orderCommission(fs, rawBefore.add(commissionRaw(fs, qty, price, multiplier)), quoteCcy);
  return total.sub(charged);
}

/** Half the quoted spread times size: what crossing the spread costs versus mid (quote currency). */
export function spreadCost(qty: Decimal, bid: Decimal, ask: Decimal, multiplier: Decimal): Decimal {
  return ask.sub(bid).div(2).mul(qty.abs()).mul(multiplier);
}

/**
 * Overnight funding for `days` nights on a position (quote currency), ACT/360, signed from the
 * customer's view (negative = charge).
 */
export function swapAmount(
  fs: FeeSchedule,
  positionQty: Decimal,
  mark: Decimal,
  multiplier: Decimal,
  days: number,
): Decimal {
  if (positionQty.isZero()) return ZERO;
  const bps = dec(positionQty.isPositive() ? fs.swapLongBps : fs.swapShortBps);
  return notional(positionQty, mark, multiplier).mul(bps).div(10_000).mul(days).div(360);
}

/** Converts a quote-currency amount to base currency and prices the conversion fee. */
export function convert(
  amount: Decimal,
  rate: Decimal,
  fxConversionBps: string,
  sameCurrency: boolean,
): { base: Decimal; cost: Decimal } {
  const base = amount.mul(rate);
  if (sameCurrency) return { base, cost: ZERO };
  return { base, cost: base.abs().mul(dec(fxConversionBps)).div(10_000) };
}

// ---- Execution: depth walk with impact and volatility terms ---------------------------------

export interface WalkParams {
  tickSize: string;
  impactTicks: string;
  volFactor: string;
  maxLevels: number;
  /** Absolute mid move since the previous quote (volatility term input). */
  lastMidMove: Decimal;
}

export interface WalkFill {
  qty: Decimal;
  price: Decimal;
  level: number;
}

function ceilToTick(v: Decimal, tick: Decimal): Decimal {
  return v.div(tick).toDecimalPlaces(0, Decimal.ROUND_CEIL).mul(tick);
}

/**
 * Walks one side of the book (best first) for `qty`. Level k fills at its price moved against the
 * taker by `k × impactTicks × tick` plus the volatility term `volFactor × lastMidMove` (rounded up
 * to a tick). A limit is never crossed: a level beyond it stops the walk and adjusted prices are
 * clamped to it. Returns fills and the unfilled remainder.
 */
export function walkBook(
  side: Side,
  levels: readonly DepthLevel[],
  qty: Decimal,
  p: WalkParams,
  limit?: Decimal,
): { fills: WalkFill[]; remaining: Decimal } {
  const tick = dec(p.tickSize);
  const vol = ceilToTick(p.lastMidMove.abs().mul(dec(p.volFactor)), tick);
  const fills: WalkFill[] = [];
  let remaining = qty;
  for (let k = 0; k < levels.length && k < p.maxLevels && remaining.gt(0); k++) {
    const [px, sz] = levels[k]!;
    const levelPrice = dec(px);
    const size = dec(sz);
    if (size.lte(0)) continue;
    if (limit && (side === 'buy' ? levelPrice.gt(limit) : levelPrice.lt(limit))) break;
    const adj = tick.mul(dec(p.impactTicks)).mul(k).add(vol);
    let price = side === 'buy' ? levelPrice.add(adj) : levelPrice.sub(adj);
    if (limit) price = side === 'buy' ? Decimal.min(price, limit) : Decimal.max(price, limit);
    if (price.lte(0)) price = tick;
    const take = Decimal.min(remaining, size);
    fills.push({ qty: take, price, level: k });
    remaining = remaining.sub(take);
  }
  return { fills, remaining };
}

/** Volume-weighted average price of fills (null when empty). */
export function vwap(fills: readonly { qty: Decimal; price: Decimal }[]): Decimal | null {
  let q = ZERO;
  let v = ZERO;
  for (const f of fills) {
    q = q.add(f.qty);
    v = v.add(f.qty.mul(f.price));
  }
  return q.isZero() ? null : v.div(q);
}

/** Total size available within `limit` (all levels when no limit), capped by `maxLevels`. */
export function availableSize(
  side: Side,
  levels: readonly DepthLevel[],
  maxLevels: number,
  limit?: Decimal,
): Decimal {
  let s = ZERO;
  for (let k = 0; k < levels.length && k < maxLevels; k++) {
    const [px, sz] = levels[k]!;
    if (limit && (side === 'buy' ? dec(px).gt(limit) : dec(px).lt(limit))) break;
    s = s.add(dec(sz));
  }
  return s;
}
