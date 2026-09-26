import { Decimal, dec } from '../decimal.js';
import type { InstrumentStatus } from '../market-data.js';
import type { SessionState } from '../sessions.js';
import { formatAmount } from './money.js';
import { isRobotSource, type ExecType, type OrderType, type TimeInForce } from './orders.js';

/**
 * Pre-trade risk (goal 03 §4). Pure and synchronous: the service loads the context, this decides.
 * Every rejection has a machine code and a plain-language message.
 */
export const RISK_CODES = [
  'MAX_ORDER_NOTIONAL',
  'FAT_FINGER',
  'MAX_POSITION',
  'MAX_LEVERAGE',
  'INSUFFICIENT_MARGIN',
  'DAILY_LOSS_LIMIT',
  'WEEKLY_LOSS_LIMIT',
  'ORDER_RATE_LIMIT',
  'SESSION_CLOSED',
  'INSTRUMENT_NOT_TRADABLE',
  'NO_MARKET_DATA',
  'MARKET_DATA_STALE',
  'FEED_NOT_OK',
  'FX_RATE_UNAVAILABLE',
  'NOVICE_ORDER_TYPE',
  'NOVICE_STOP_REQUIRED',
  'NOVICE_LEVERAGE',
  'REDUCE_ONLY_WOULD_INCREASE',
  'POST_ONLY_WOULD_TAKE',
  'STOP_LOSS_WRONG_SIDE',
  'TAKE_PROFIT_WRONG_SIDE',
  'TRADING_HALTED',
  'FOK_INSUFFICIENT_DEPTH',
  // Goal 08 (novice guardrails and the monthly loss limit).
  'MONTHLY_LOSS_LIMIT',
  'NOVICE_COOLING_OFF',
] as const;
export type RiskCode = (typeof RISK_CODES)[number];

export interface RiskViolation {
  code: RiskCode;
  message: string;
}

/** Account risk limits in base currency. Platform defaults are SIMULATED placeholders (OQ-R3). */
export interface RiskLimits {
  maxOrderNotional: string;
  maxPositionNotional: string;
  maxLeverage: string;
  dailyLossLimit: string;
  weeklyLossLimit: string;
  maxOrdersPerMinute: number;
  /** Optional (goal 08): no platform default; set by the account holder. */
  monthlyLossLimit?: string;
}

/** Why a guarded (Novice) account is cooling off until the next day (goal 08). */
export type CoolingOffReason = 'losing_trades' | 'daily_loss_pct' | 'daily_loss_limit';

export type MarketDataState = 'ok' | 'no_quote' | 'stale' | 'feed_not_ok';

export interface RiskContext {
  order: {
    type: OrderType;
    execType: ExecType;
    tif: TimeInForce;
    reduceOnly: boolean;
    postOnly: boolean;
    source: string;
    /** Prices the fat-finger band applies to (limit/stop/stop-loss/take-profit). */
    prices: Decimal[];
    hasStopLoss: boolean;
    /** Would a limit (or post-only) cross the spread right now? */
    marketable: boolean;
  };
  baseCcy: string;
  instrumentStatus: InstrumentStatus;
  session: SessionState;
  marketData: MarketDataState;
  fxAvailable: boolean;
  mid: Decimal | null;
  fatFingerPct: Decimal;
  notionalBase: Decimal;
  /** |position| before and after, and position notional after (base). */
  positionQtyBefore: Decimal;
  positionQtyAfter: Decimal;
  positionNotionalAfter: Decimal;
  grossExposureAfter: Decimal;
  equity: Decimal;
  marginAfter: Decimal;
  dayPnl: Decimal;
  weekPnl: Decimal;
  ordersLastMinute: number;
  limits: RiskLimits;
  novice: boolean;
  /** Novice borrowing cap as a multiple of equity: 1 = no leverage (the default). */
  noviceMaxLeverage?: Decimal;
  /** Set when a guarded account is cooling off (goal 08); only reducing orders pass. */
  coolingOff?: CoolingOffReason | null;
  /** Month-to-date P&L in base currency (goal 08 monthly loss limit). */
  monthPnl?: Decimal;
  halted: boolean;
  previewIssues: RiskViolation[];
  /** FOK: size available now within the limit. */
  availableNow: Decimal | null;
  qty: Decimal;
}

/** Orders that fill on arrival need a safe market; resting orders are held until it is safe. */
export function fillsImmediately(ctx: Pick<RiskContext, 'order'>): boolean {
  const o = ctx.order;
  return (
    o.execType === 'market' ||
    o.tif === 'ioc' ||
    o.tif === 'fok' ||
    (o.execType === 'limit' && o.marketable)
  );
}

export function evaluateRisk(ctx: RiskContext): RiskViolation[] {
  const v: RiskViolation[] = [];
  const add = (code: RiskCode, message: string) => v.push({ code, message });
  const ccy = ctx.baseCcy;
  const money = (d: Decimal) => `${formatAmount(d, ccy)} ${ccy}`;
  // Opposite to an open position. A reduce-only order larger than the position is clipped by the
  // engine at fill time, so it can never increase or flip exposure.
  const opposite = ctx.positionQtyAfter.sub(ctx.positionQtyBefore).mul(ctx.positionQtyBefore).lt(0); // lt: decimal.js keeps -0
  const reducing =
    (ctx.order.reduceOnly && opposite) ||
    (ctx.positionQtyAfter.abs().lte(ctx.positionQtyBefore.abs()) &&
      !ctx.positionQtyBefore.isZero() &&
      ctx.positionQtyAfter.mul(ctx.positionQtyBefore).gte(0));
  const immediate = fillsImmediately(ctx);

  if (ctx.halted && isRobotSource(ctx.order.source))
    add(
      'TRADING_HALTED',
      'Trading is halted by the kill switch. Robot orders are blocked until someone authorised resumes trading.',
    );
  if (ctx.instrumentStatus !== 'active')
    add(
      'INSTRUMENT_NOT_TRADABLE',
      `This instrument is ${ctx.instrumentStatus} and cannot be traded.`,
    );
  if (ctx.marketData === 'no_quote')
    add(
      'NO_MARKET_DATA',
      'There is no price for this instrument yet, so the order cannot be checked or filled.',
    );
  else if (immediate && ctx.marketData === 'stale')
    add(
      'MARKET_DATA_STALE',
      'The latest price is stale. Orders that fill now are refused until prices are fresh again.',
    );
  else if (immediate && ctx.marketData === 'feed_not_ok')
    add(
      'FEED_NOT_OK',
      'The price feed is not healthy. Orders that fill now are refused until it recovers.',
    );
  if (immediate && ctx.session !== 'open')
    add(
      'SESSION_CLOSED',
      `The market is ${ctx.session === 'break' ? 'on a break' : ctx.session}. Orders that fill now are refused; place a resting order instead.`,
    );
  if (!ctx.fxAvailable)
    add(
      'FX_RATE_UNAVAILABLE',
      `No fresh exchange rate to ${ccy} is available, so costs and margin cannot be priced.`,
    );
  for (const i of ctx.previewIssues) add(i.code, i.message);

  // Novice guardrails (server-enforced; goal 08 uses the same rules).
  if (ctx.novice) {
    if (ctx.order.type !== 'market')
      add(
        'NOVICE_ORDER_TYPE',
        'In the simple view you can only place market orders with a protective stop.',
      );
    if (!reducing && !ctx.order.hasStopLoss)
      add(
        'NOVICE_STOP_REQUIRED',
        'Add a stop loss. In the simple view every new trade needs one so the loss is capped.',
      );
    const cap = ctx.noviceMaxLeverage ?? new Decimal(1);
    if (!reducing && ctx.grossExposureAfter.gt(ctx.equity.mul(cap)))
      add(
        'NOVICE_LEVERAGE',
        cap.lte(1)
          ? 'This trade would need borrowing (leverage), which is off in the simple view. Reduce the size.'
          : `This trade would borrow more than ${cap.toFixed()}× your balance, the most allowed in the simple view. Reduce the size.`,
      );
    if (!reducing && ctx.coolingOff)
      add(
        'NOVICE_COOLING_OFF',
        ctx.coolingOff === 'losing_trades'
          ? 'Time for a break: you had several losing trades today. New trades open again tomorrow; you can still close trades.'
          : ctx.coolingOff === 'daily_loss_pct'
            ? 'Time for a break: today’s loss is large for your balance. New trades open again tomorrow; you can still close trades.'
            : 'Time for a break: you reached your daily loss limit. New trades open again tomorrow; you can still close trades.',
      );
  }

  if (ctx.notionalBase.gt(dec(ctx.limits.maxOrderNotional)))
    add(
      'MAX_ORDER_NOTIONAL',
      `Order value ${money(ctx.notionalBase)} is above the ${money(dec(ctx.limits.maxOrderNotional))} limit per order.`,
    );
  if (ctx.mid && ctx.mid.gt(0)) {
    const band = ctx.fatFingerPct;
    const far = ctx.order.prices.find((p) => p.sub(ctx.mid!).abs().div(ctx.mid!).mul(100).gt(band));
    if (far)
      add(
        'FAT_FINGER',
        `The price ${far.toFixed()} is more than ${band.toFixed()}% away from the market (${ctx.mid.toFixed()}). Check for a typo.`,
      );
  }
  if (ctx.order.reduceOnly && !reducing)
    add('REDUCE_ONLY_WOULD_INCREASE', 'Reduce-only orders can only make an open position smaller.');
  if (ctx.order.postOnly && ctx.order.marketable)
    add(
      'POST_ONLY_WOULD_TAKE',
      'A post-only order must not trade immediately; this price would cross the spread.',
    );
  if (ctx.order.tif === 'fok' && ctx.availableNow && ctx.availableNow.lt(ctx.qty))
    add(
      'FOK_INSUFFICIENT_DEPTH',
      'Fill-or-kill: the visible market cannot fill the whole size at once.',
    );

  if (!reducing) {
    if (ctx.positionNotionalAfter.gt(dec(ctx.limits.maxPositionNotional)))
      add(
        'MAX_POSITION',
        `The position would be worth ${money(ctx.positionNotionalAfter)}, above the ${money(dec(ctx.limits.maxPositionNotional))} limit per instrument.`,
      );
    const lev = ctx.equity.gt(0) ? ctx.grossExposureAfter.div(ctx.equity) : new Decimal(Infinity);
    if (lev.gt(dec(ctx.limits.maxLeverage)))
      add(
        'MAX_LEVERAGE',
        `Total exposure would be ${lev.isFinite() ? lev.toDecimalPlaces(1).toFixed(1) : 'unbounded'}× equity, above the ${ctx.limits.maxLeverage}× limit.`,
      );
    if (ctx.marginAfter.gt(ctx.equity))
      add(
        'INSUFFICIENT_MARGIN',
        `Margin needed (${money(ctx.marginAfter)}) would exceed equity (${money(ctx.equity)}).`,
      );
    if (ctx.dayPnl.neg().gte(dec(ctx.limits.dailyLossLimit)))
      add(
        'DAILY_LOSS_LIMIT',
        `Today's loss has reached the ${money(dec(ctx.limits.dailyLossLimit))} daily limit. Only orders that reduce positions are allowed until tomorrow.`,
      );
    if (
      ctx.limits.monthlyLossLimit !== undefined &&
      ctx.monthPnl &&
      ctx.monthPnl.neg().gte(dec(ctx.limits.monthlyLossLimit))
    )
      add(
        'MONTHLY_LOSS_LIMIT',
        `This month's loss has reached the ${money(dec(ctx.limits.monthlyLossLimit))} monthly limit. Only orders that reduce positions are allowed.`,
      );
    if (ctx.weekPnl.neg().gte(dec(ctx.limits.weeklyLossLimit)))
      add(
        'WEEKLY_LOSS_LIMIT',
        `This week's loss has reached the ${money(dec(ctx.limits.weeklyLossLimit))} weekly limit. Only orders that reduce positions are allowed.`,
      );
  }
  if (ctx.ordersLastMinute >= ctx.limits.maxOrdersPerMinute)
    add(
      'ORDER_RATE_LIMIT',
      `You have sent ${ctx.ordersLastMinute} orders in the last minute; the limit is ${ctx.limits.maxOrdersPerMinute}. Wait a moment.`,
    );
  return v;
}
