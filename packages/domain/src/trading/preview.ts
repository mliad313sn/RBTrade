import { Decimal } from '../decimal.js';
import type { DepthLevel } from '../market-data.js';
import {
  commission,
  convert,
  notional,
  spreadCost,
  vwap,
  walkBook,
  type FeeSchedule,
  type WalkParams,
} from './costs.js';
import { formatAmount, formatPct, ZERO } from './money.js';
import { sideSign, type ExecType, type Side } from './orders.js';

/**
 * Order preview (goal 03 §5, "No hidden risk"): notional, fees and spread, margin impact, loss if the
 * stop is hit (currency and % of equity), reward:risk and whether confirmation is required. Pure, so
 * the hand-computed fixtures run here and through `POST /orders/preview`.
 */

export const CONFIRM_MODES = ['always', 'above_thresholds', 'never'] as const;
export type ConfirmMode = (typeof CONFIRM_MODES)[number];

export interface ConfirmSettings {
  mode: ConfirmMode;
  /** Base-currency notional above which confirmation is required. */
  notionalAbove: Decimal;
  /** Loss-at-stop as % of equity above which confirmation is required. */
  lossPctAbove: Decimal;
}

export interface PreviewInput {
  side: Side;
  qty: Decimal;
  execType: Exclude<ExecType, 'none'>;
  limitPrice?: Decimal;
  stopPrice?: Decimal;
  trailAmount?: Decimal;
  stopLossPrice?: Decimal;
  takeProfitPrice?: Decimal;
  quote: { bid: Decimal; ask: Decimal };
  depth: { bids: DepthLevel[]; asks: DepthLevel[] } | null;
  walk: WalkParams;
  pricePrecision: number;
  multiplier: Decimal;
  quoteCcy: string;
  baseCcy: string;
  fees: FeeSchedule;
  marginRate: Decimal;
  /** Quote → base rate (1 when the currencies match). */
  fxRate: Decimal;
  equity: Decimal;
  marginUsed: Decimal;
  /** Current signed position in this symbol. */
  positionQty: Decimal;
  confirm: ConfirmSettings;
}

export interface PreviewResult {
  side: Side;
  qty: string;
  estimatedPrice: string;
  estimatedPriceExact: Decimal;
  /** True when visible depth cannot fill the whole size at once (partial fills expected). */
  exceedsVisibleDepth: boolean;
  currency: string;
  notional: { quote: string; quoteCcy: string; base: string };
  fees: { commission: string; spread: string; fxConversion: string; total: string };
  margin: {
    rate: string;
    required: string;
    change: string;
    usedAfter: string;
    freeAfter: string;
    equity: string;
  };
  lossIfStopHit: {
    stopPrice: string;
    price: string;
    costs: string;
    total: string;
    pctEquity: string;
  } | null;
  rewardIfTargetHit: { targetPrice: string; amount: string } | null;
  /** Reward per unit of risk, "2.00" means 1 : 2.00. */
  rewardRisk: string | null;
  fx: {
    from: string;
    to: string;
    rate: string;
    conversionBps: string;
    conversionCost: string;
  } | null;
  confirmation: { required: boolean; reasons: string[] };
  issues: Array<{ code: 'STOP_LOSS_WRONG_SIDE' | 'TAKE_PROFIT_WRONG_SIDE'; message: string }>;
  /** Exact base-currency figures for the risk service. */
  exact: {
    notionalBase: Decimal;
    marginRequired: Decimal;
    marginAfter: Decimal;
    lossAtStopTotal: Decimal | null;
  };
}

function estimatePrice(i: PreviewInput): { price: Decimal; exceeds: boolean } {
  const touch = i.side === 'buy' ? i.quote.ask : i.quote.bid;
  const book = i.depth
    ? i.side === 'buy'
      ? i.depth.asks
      : i.depth.bids
    : [[touch.toFixed(), i.qty.toFixed()] as DepthLevel];
  const marketable = (limit: Decimal) => (i.side === 'buy' ? limit.gte(touch) : limit.lte(touch));
  switch (i.execType) {
    case 'market': {
      const w = walkBook(i.side, book, i.qty, i.walk);
      const filled = w.fills.length ? w.fills : [{ qty: i.qty, price: touch }];
      const last = filled[filled.length - 1]!.price;
      const all = w.remaining.gt(0) ? [...filled, { qty: w.remaining, price: last }] : filled;
      return { price: vwap(all)!, exceeds: w.remaining.gt(0) };
    }
    case 'limit': {
      const limit = i.limitPrice!;
      if (!marketable(limit)) return { price: limit, exceeds: false };
      const w = walkBook(i.side, book, i.qty, i.walk, limit);
      const all = w.remaining.gt(0) ? [...w.fills, { qty: w.remaining, price: limit }] : w.fills;
      return { price: vwap(all) ?? limit, exceeds: w.remaining.gt(0) };
    }
    case 'stop':
      return { price: i.stopPrice!, exceeds: false };
    case 'stop_limit':
      return { price: i.limitPrice!, exceeds: false };
    case 'trailing':
      return {
        price: i.side === 'buy' ? i.quote.ask.add(i.trailAmount!) : i.quote.bid.sub(i.trailAmount!),
        exceeds: false,
      };
  }
}

export function computePreview(i: PreviewInput): PreviewResult {
  const ccy = i.baseCcy;
  const same = i.quoteCcy === i.baseCcy;
  const bps = i.fees.fxConversionBps;
  const { price, exceeds } = estimatePrice(i);
  const notionalQuote = notional(i.qty, price, i.multiplier);
  const notionalBase = notionalQuote.mul(i.fxRate);

  // Fees on entry: commission (quote → base, conversion charged), half-spread versus mid.
  const commQuote = commission(i.fees, i.qty, price, i.multiplier, i.quoteCcy);
  const comm = convert(commQuote, i.fxRate, bps, same);
  const spread = spreadCost(i.qty, i.quote.bid, i.quote.ask, i.multiplier).mul(i.fxRate);
  const feeTotal = comm.base.add(spread).add(comm.cost);

  // Margin: required for this order, and the change in the account's margin once filled.
  const signed = i.qty.mul(sideSign(i.side));
  const after = i.positionQty.add(signed);
  const marginOf = (q: Decimal) => notional(q, price, i.multiplier).mul(i.fxRate).mul(i.marginRate);
  const required = marginOf(i.qty);
  const change = marginOf(after).sub(marginOf(i.positionQty));
  const marginAfter = i.marginUsed.add(change);
  const equityAfterFees = i.equity.sub(feeTotal);

  const issues: PreviewResult['issues'] = [];
  const dir = sideSign(i.side);
  let loss: PreviewResult['lossIfStopHit'] = null;
  let lossTotal: Decimal | null = null;
  let lossPrice: Decimal | null = null;
  let stopConversion = ZERO;
  if (i.stopLossPrice) {
    const distance = price.sub(i.stopLossPrice).mul(dir); // > 0 when the stop is on the losing side
    if (distance.lte(0)) {
      issues.push({
        code: 'STOP_LOSS_WRONG_SIDE',
        message: `The stop loss must be ${i.side === 'buy' ? 'below' : 'above'} the entry price.`,
      });
    } else {
      lossPrice = distance.mul(i.qty).mul(i.multiplier).mul(i.fxRate);
      const exitCommQuote = commission(i.fees, i.qty, i.stopLossPrice, i.multiplier, i.quoteCcy);
      const exitComm = convert(exitCommQuote, i.fxRate, bps, same);
      const lossConv = convert(distance.mul(i.qty).mul(i.multiplier), i.fxRate, bps, same).cost;
      stopConversion = exitComm.cost.add(lossConv);
      const costs = comm.base.add(comm.cost).add(exitComm.base).add(stopConversion);
      lossTotal = lossPrice.add(costs);
      loss = {
        stopPrice: i.stopLossPrice.toFixed(i.pricePrecision),
        price: formatAmount(lossPrice, ccy),
        costs: formatAmount(costs, ccy),
        total: formatAmount(lossTotal, ccy),
        pctEquity: i.equity.gt(0) ? formatPct(lossTotal.div(i.equity)) : '100.00',
      };
    }
  }
  let reward: PreviewResult['rewardIfTargetHit'] = null;
  let rewardRisk: string | null = null;
  if (i.takeProfitPrice) {
    const distance = i.takeProfitPrice.sub(price).mul(dir);
    if (distance.lte(0)) {
      issues.push({
        code: 'TAKE_PROFIT_WRONG_SIDE',
        message: `The take profit must be ${i.side === 'buy' ? 'above' : 'below'} the entry price.`,
      });
    } else {
      const amount = distance.mul(i.qty).mul(i.multiplier).mul(i.fxRate);
      reward = {
        targetPrice: i.takeProfitPrice.toFixed(i.pricePrecision),
        amount: formatAmount(amount, ccy),
      };
      if (lossPrice && lossPrice.gt(0))
        rewardRisk = amount.div(lossPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
    }
  }

  const reasons: string[] = [];
  if (i.confirm.mode === 'always') reasons.push('You asked to confirm every order.');
  if (i.confirm.mode === 'above_thresholds') {
    if (notionalBase.gt(i.confirm.notionalAbove))
      reasons.push(
        `Notional is above your ${formatAmount(i.confirm.notionalAbove, ccy)} ${ccy} confirmation threshold.`,
      );
    if (
      lossTotal &&
      i.equity.gt(0) &&
      lossTotal.div(i.equity).mul(100).gt(i.confirm.lossPctAbove)
    ) {
      reasons.push(
        `Loss if the stop is hit is above ${i.confirm.lossPctAbove.toFixed()}% of equity.`,
      );
    }
    if (!i.stopLossPrice && !after.abs().lt(i.positionQty.abs()))
      reasons.push('No stop loss: the loss on this order is not capped.');
  }

  return {
    side: i.side,
    qty: i.qty.toFixed(),
    estimatedPrice: price
      .toDecimalPlaces(i.pricePrecision, Decimal.ROUND_HALF_EVEN)
      .toFixed(i.pricePrecision),
    estimatedPriceExact: price,
    exceedsVisibleDepth: exceeds,
    currency: ccy,
    notional: {
      quote: formatAmount(notionalQuote, i.quoteCcy),
      quoteCcy: i.quoteCcy,
      base: formatAmount(notionalBase, ccy),
    },
    fees: {
      commission: formatAmount(comm.base, ccy),
      spread: formatAmount(spread, ccy),
      fxConversion: formatAmount(comm.cost, ccy),
      total: formatAmount(feeTotal, ccy),
    },
    margin: {
      rate: i.marginRate.toFixed(),
      required: formatAmount(required, ccy),
      change: formatAmount(change, ccy),
      usedAfter: formatAmount(marginAfter, ccy),
      freeAfter: formatAmount(equityAfterFees.sub(marginAfter), ccy),
      equity: formatAmount(i.equity, ccy),
    },
    lossIfStopHit: loss,
    rewardIfTargetHit: reward,
    rewardRisk,
    fx: same
      ? null
      : {
          from: i.quoteCcy,
          to: ccy,
          rate: i.fxRate.toFixed(),
          conversionBps: bps,
          conversionCost: formatAmount(comm.cost.add(stopConversion), ccy),
        },
    confirmation: { required: reasons.length > 0, reasons },
    issues,
    exact: { notionalBase, marginRequired: required, marginAfter, lossAtStopTotal: lossTotal },
  };
}
