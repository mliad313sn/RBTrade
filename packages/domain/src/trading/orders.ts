import { z } from 'zod';

import { DECIMAL_STRING } from '../decimal.js';
import { SYMBOL_RE } from '../market-data.js';

/**
 * Order contract (goal 03). Prices and quantities are decimal strings on the wire; the registry
 * decides tick, qty step and precision (validated server-side against the instrument).
 */

export const ORDER_TYPES = [
  'market',
  'limit',
  'stop',
  'stop_limit',
  'trailing',
  'bracket',
  'oco',
] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** How the engine works a row. `none` = container (OCO parent) that never executes itself. */
export const EXEC_TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing', 'none'] as const;
export type ExecType = (typeof EXEC_TYPES)[number];

export const TIME_IN_FORCE = ['day', 'gtc', 'ioc', 'fok', 'gtd'] as const;
export type TimeInForce = (typeof TIME_IN_FORCE)[number];

export const ORDER_STATUSES = [
  'new',
  'accepted',
  'working',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected',
  'expired',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  'new',
  'accepted',
  'working',
  'partially_filled',
];

/** What a row is inside a group. */
export const ORDER_ROLES = ['primary', 'stop_loss', 'take_profit', 'oco_leg'] as const;
export type OrderRole = (typeof ORDER_ROLES)[number];

export const SIDES = ['buy', 'sell'] as const;
export type Side = (typeof SIDES)[number];

/**
 * Order source. Manual and accepted AI drafts come from REST; `robot:{uuid}` only through the
 * internal OMS call used by the bot runner (goal 06); `kill-switch` for flatten orders.
 */
export type OrderSource = 'manual' | 'ai-draft-accepted' | 'kill-switch' | `robot:${string}`;
export const ORDER_SOURCE_RE =
  /^(manual|ai-draft-accepted|kill-switch|robot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const REST_ORDER_SOURCES = ['manual', 'ai-draft-accepted'] as const;

export function isRobotSource(s: string): boolean {
  return s.startsWith('robot:');
}

export function sideSign(side: Side): 1 | -1 {
  return side === 'buy' ? 1 : -1;
}

export function oppositeSide(side: Side): Side {
  return side === 'buy' ? 'sell' : 'buy';
}

const decimalString = z
  .string()
  .trim()
  .regex(DECIMAL_STRING, 'Use a decimal number such as 1.2345');
const positiveDecimal = decimalString.refine(
  (s) => !s.startsWith('-') && /[1-9]/.test(s),
  'Must be greater than zero',
);
const clientOrderId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, dot, dash, underscore or colon');

const OcoLegSchema = z
  .object({
    type: z.enum(['limit', 'stop', 'stop_limit']),
    limitPrice: positiveDecimal.optional(),
    stopPrice: positiveDecimal.optional(),
  })
  .strict();
export type OcoLeg = z.infer<typeof OcoLegSchema>;

/** Shared order fields; the refinements below check per-type requirements. */
export const PlaceOrderBaseSchema = z
  .object({
    clientOrderId,
    symbol: z.string().regex(SYMBOL_RE, 'Unknown symbol format'),
    side: z.enum(SIDES),
    type: z.enum(ORDER_TYPES),
    qty: positiveDecimal,
    limitPrice: positiveDecimal.optional(),
    stopPrice: positiveDecimal.optional(),
    /** Trailing distance in price units (trailing stops). */
    trailAmount: positiveDecimal.optional(),
    /** Bracket entry: market (default) or limit. */
    entryType: z.enum(['market', 'limit']).optional(),
    stopLossPrice: positiveDecimal.optional(),
    takeProfitPrice: positiveDecimal.optional(),
    legs: z.array(OcoLegSchema).length(2).optional(),
    tif: z.enum(TIME_IN_FORCE).default('gtc'),
    /** GTD expiry (ISO-8601 with offset). */
    expireAt: z.iso.datetime({ offset: true }).optional(),
    reduceOnly: z.boolean().default(false),
    postOnly: z.boolean().default(false),
    source: z.enum(REST_ORDER_SOURCES).default('manual'),
    /**
     * IRTC R4-06: the AI draft this order was placed from (ticket prefill). The server decides the
     * source: `ai-draft-accepted` only when the order matches that draft; the client cannot set it.
     */
    aiDraftId: z.uuid().optional(),
  })
  .strict();

type Base = z.infer<typeof PlaceOrderBaseSchema>;

/** Returns human messages for a structurally valid request that is inconsistent. */
export function orderShapeIssues(o: Base): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const need = (field: keyof Base, why: string) => {
    if (o[field] === undefined) issues.push({ path: field, message: why });
  };
  const forbid = (field: keyof Base, why: string) => {
    if (o[field] !== undefined) issues.push({ path: field, message: why });
  };
  switch (o.type) {
    case 'market':
      forbid('limitPrice', 'A market order has no limit price');
      forbid('stopPrice', 'A market order has no stop price');
      if (o.postOnly)
        issues.push({ path: 'postOnly', message: 'A market order cannot be post-only' });
      break;
    case 'limit':
      need('limitPrice', 'A limit order needs a limit price');
      forbid('stopPrice', 'A limit order has no stop price; use stop-limit');
      break;
    case 'stop':
      need('stopPrice', 'A stop order needs a stop price');
      forbid('limitPrice', 'A stop order has no limit price; use stop-limit');
      break;
    case 'stop_limit':
      need('stopPrice', 'A stop-limit order needs a stop price');
      need('limitPrice', 'A stop-limit order needs a limit price');
      break;
    case 'trailing':
      need('trailAmount', 'A trailing stop needs a trailing distance');
      // IRTC R2-16: the engine derives the stop from the trailing distance and never uses a limit.
      forbid('limitPrice', 'A trailing stop has no limit price');
      forbid('stopPrice', 'A trailing stop sets its own stop price from the trailing distance');
      break;
    case 'bracket':
      need('stopLossPrice', 'A bracket needs a stop loss');
      need('takeProfitPrice', 'A bracket needs a take profit');
      if ((o.entryType ?? 'market') === 'limit')
        need('limitPrice', 'A limit bracket entry needs a limit price');
      else forbid('limitPrice', 'A market bracket entry has no limit price');
      break;
    case 'oco':
      need('legs', 'An OCO order needs two legs');
      forbid('stopLossPrice', 'OCO legs cannot carry attached stops');
      forbid('takeProfitPrice', 'OCO legs cannot carry attached targets');
      for (const [i, leg] of (o.legs ?? []).entries()) {
        if ((leg.type === 'limit' || leg.type === 'stop_limit') && !leg.limitPrice)
          issues.push({ path: `legs.${i}.limitPrice`, message: 'This leg needs a limit price' });
        if ((leg.type === 'stop' || leg.type === 'stop_limit') && !leg.stopPrice)
          issues.push({ path: `legs.${i}.stopPrice`, message: 'This leg needs a stop price' });
      }
      break;
  }
  if (o.type !== 'trailing') forbid('trailAmount', 'Only trailing stops take a trailing distance');
  if (o.type !== 'oco') forbid('legs', 'Only OCO orders take legs');
  if (o.type !== 'bracket') forbid('entryType', 'Only brackets take an entry type');
  if (o.tif === 'gtd') need('expireAt', 'Good-till-date needs an expiry time');
  else forbid('expireAt', 'Only good-till-date orders take an expiry time');
  // IRTC R2-16: stop orders rest until triggered, so immediate-or-cancel / fill-or-kill cannot apply.
  if (
    (o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing') &&
    (o.tif === 'ioc' || o.tif === 'fok')
  )
    issues.push({
      path: 'tif',
      message: 'Stop orders wait for their trigger; use GTC, Day or GTD instead of IOC or FOK',
    });
  if (o.postOnly && (o.tif === 'ioc' || o.tif === 'fok'))
    issues.push({
      path: 'postOnly',
      message: 'Post-only cannot be immediate-or-cancel or fill-or-kill',
    });
  if (o.reduceOnly && (o.stopLossPrice || o.takeProfitPrice))
    issues.push({
      path: 'reduceOnly',
      message: 'A reduce-only order cannot open protective orders',
    });
  return issues;
}

export const PlaceOrderSchema = PlaceOrderBaseSchema.superRefine((o, ctx) => {
  for (const i of orderShapeIssues(o))
    ctx.addIssue({ code: 'custom', path: i.path.split('.'), message: i.message });
});
export type PlaceOrderRequest = z.infer<typeof PlaceOrderSchema>;

/** Preview takes the same body; the client order id is optional there. */
export const PreviewOrderSchema = PlaceOrderBaseSchema.extend({
  clientOrderId: clientOrderId.optional(),
}).superRefine((o, ctx) => {
  for (const i of orderShapeIssues({ ...o, clientOrderId: o.clientOrderId ?? 'preview' })) {
    ctx.addIssue({ code: 'custom', path: i.path.split('.'), message: i.message });
  }
});
export type PreviewOrderRequest = z.infer<typeof PreviewOrderSchema>;

export const AmendOrderSchema = z
  .object({
    qty: positiveDecimal.optional(),
    limitPrice: positiveDecimal.optional(),
    stopPrice: positiveDecimal.optional(),
    trailAmount: positiveDecimal.optional(),
  })
  .strict()
  .refine((a) => Object.keys(a).length > 0, 'Change at least one field');
export type AmendOrderRequest = z.infer<typeof AmendOrderSchema>;

/** Execution type of the row the engine works for a request (brackets: the entry). */
export function execTypeFor(o: Pick<Base, 'type' | 'entryType'>): ExecType {
  switch (o.type) {
    case 'bracket':
      return o.entryType ?? 'market';
    case 'oco':
      return 'none';
    default:
      return o.type;
  }
}

/** Wire shape of an order row. */
export interface OrderDto {
  id: string;
  accountId: string;
  clientOrderId: string | null;
  parentOrderId: string | null;
  ocoGroup: string | null;
  role: OrderRole;
  symbol: string;
  side: Side;
  type: OrderType;
  execType: ExecType;
  qty: string;
  filledQty: string;
  avgFillPrice: string | null;
  limitPrice: string | null;
  stopPrice: string | null;
  trailAmount: string | null;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  tif: TimeInForce;
  expireAt: string | null;
  reduceOnly: boolean;
  postOnly: boolean;
  source: OrderSource;
  status: OrderStatus;
  rejectCode: string | null;
  rejectMessage: string | null;
  cancelReason: string | null;
  triggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FillDto {
  id: string;
  orderId: string;
  accountId: string;
  symbol: string;
  side: Side;
  qty: string;
  price: string;
  /** Adverse price difference vs the reference (touch at decision, stop or limit); negative = improvement. */
  slippage: string;
  /** Base-currency amounts. */
  commission: string;
  spreadCost: string;
  fxConversionCost: string;
  realizedPnl: string;
  fxRate: string;
  quoteAtDecision: {
    bid: string;
    ask: string;
    seq: number;
    source: string;
    exchangeTs: number;
    receivedTs: number;
  };
  referencePrice: string;
  liquidity: 'taker' | 'maker';
  ts: string;
}

export interface PositionDto {
  accountId: string;
  symbol: string;
  qty: string;
  avgPrice: string;
  markPrice: string | null;
  quoteCcy: string;
  unrealizedPnl: string | null;
  realizedPnl: string;
  notional: string | null;
  marginUsed: string | null;
  updatedAt: string;
  /** Mark or FX rate is stale or missing: values are indicative. */
  stale: boolean;
}
