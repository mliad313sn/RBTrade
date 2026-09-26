import type {
  ExecType,
  FillDto,
  KillSwitchScope,
  OrderDto,
  OrderRole,
  OrderSource,
  OrderStatus,
  OrderType,
  Side,
  TimeInForce,
} from '@kora/domain';

/** Database rows (numeric columns arrive as strings; never converted to JS numbers). */
export interface AccountRow {
  id: string;
  user_id: string;
  environment: 'PAPER' | 'LIVE';
  base_currency: string;
  margin_tier: string;
  status: 'active' | 'disabled';
  starting_cash: string;
  cash: string;
  trading_halted: boolean;
  halt_scope: KillSwitchScope | null;
  halted_at: Date | null;
  halted_by: string | null;
  halt_reason: string | null;
  settings: Record<string, unknown>;
  risk_limits: Record<string, unknown>;
  created_at: Date;
}

export interface OrderRow {
  id: string;
  account_id: string;
  client_order_id: string | null;
  request_hash: string | null;
  parent_order_id: string | null;
  oco_group: string | null;
  role: OrderRole;
  symbol: string;
  side: Side;
  type: OrderType;
  exec_type: ExecType;
  qty: string;
  filled_qty: string;
  avg_fill_price: string | null;
  limit_price: string | null;
  stop_price: string | null;
  trail_amount: string | null;
  trail_ref_price: string | null;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  tif: TimeInForce;
  expire_at: Date | null;
  reduce_only: boolean;
  post_only: boolean;
  source: OrderSource;
  status: OrderStatus;
  reject_code: string | null;
  reject_message: string | null;
  cancel_reason: string | null;
  triggered_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface FillRow {
  id: string;
  order_id: string;
  account_id: string;
  symbol: string;
  side: Side;
  qty: string;
  price: string;
  quote_at_decision: FillDto['quoteAtDecision'];
  reference_price: string;
  slippage: string;
  commission: string;
  spread_cost: string;
  fx_rate: string;
  fx_conversion_cost: string;
  realized_pnl: string;
  liquidity: 'taker' | 'maker';
  ts: Date;
}

export interface PositionRow {
  account_id: string;
  symbol: string;
  qty: string;
  avg_price: string;
  realized_pnl: string;
  opened_at: Date | null;
  updated_at: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Normalises numeric strings from Postgres (trims trailing zeros, keeps exact value). */
export function num(s: string): string {
  if (!s.includes('.')) return s;
  const t = s.replace(/0+$/, '');
  return t.endsWith('.') ? t.slice(0, -1) : t;
}
const numOrNull = (s: string | null): string | null => (s === null ? null : num(s));

export function toOrderDto(r: OrderRow): OrderDto {
  return {
    id: r.id,
    accountId: r.account_id,
    clientOrderId: r.client_order_id,
    parentOrderId: r.parent_order_id,
    ocoGroup: r.oco_group,
    role: r.role,
    symbol: r.symbol,
    side: r.side,
    type: r.type,
    execType: r.exec_type,
    qty: num(r.qty),
    filledQty: num(r.filled_qty),
    avgFillPrice: numOrNull(r.avg_fill_price),
    limitPrice: numOrNull(r.limit_price),
    stopPrice: numOrNull(r.stop_price),
    trailAmount: numOrNull(r.trail_amount),
    stopLossPrice: numOrNull(r.stop_loss_price),
    takeProfitPrice: numOrNull(r.take_profit_price),
    tif: r.tif,
    expireAt: iso(r.expire_at),
    reduceOnly: r.reduce_only,
    postOnly: r.post_only,
    source: r.source,
    status: r.status,
    rejectCode: r.reject_code,
    rejectMessage: r.reject_message,
    cancelReason: r.cancel_reason,
    triggeredAt: iso(r.triggered_at),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export function toFillDto(r: FillRow): FillDto {
  return {
    id: r.id,
    orderId: r.order_id,
    accountId: r.account_id,
    symbol: r.symbol,
    side: r.side,
    qty: num(r.qty),
    price: num(r.price),
    slippage: num(r.slippage),
    commission: num(r.commission),
    spreadCost: num(r.spread_cost),
    fxConversionCost: num(r.fx_conversion_cost),
    realizedPnl: num(r.realized_pnl),
    fxRate: num(r.fx_rate),
    quoteAtDecision: r.quote_at_decision,
    referencePrice: num(r.reference_price),
    liquidity: r.liquidity,
    ts: r.ts.toISOString(),
  };
}

/** Everything a committed transaction changed, published on the WebSocket afterwards. */
export class ChangeSet {
  readonly orders = new Map<string, OrderRow>();
  readonly accounts = new Set<string>();
  readonly positions = new Set<string>();
  readonly symbols = new Set<string>();

  order(r: OrderRow): void {
    this.orders.set(r.id, r);
    this.accounts.add(r.account_id);
    this.symbols.add(r.symbol);
  }

  position(accountId: string): void {
    this.positions.add(accountId);
    this.accounts.add(accountId);
  }

  merge(o: ChangeSet): void {
    for (const r of o.orders.values()) this.order(r);
    for (const a of o.positions) this.position(a);
    for (const a of o.accounts) this.accounts.add(a);
  }
}

export const ORDER_COLUMNS = '*';
