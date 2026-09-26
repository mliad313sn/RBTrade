import type { Decimal } from './decimal.js';

/** Shared domain types. Money fields are decimal strings on the wire and Decimal in memory. */
export type DecimalString = string;

export const ENVIRONMENTS = ['PAPER', 'LIVE'] as const;
export type TradingEnvironment = (typeof ENVIRONMENTS)[number];

export type AssetClass = 'fx' | 'metal' | 'crypto' | 'index_cfd' | 'equity' | 'energy';

export interface Instrument {
  symbol: string; // e.g. EURUSD
  displayName: string; // e.g. EUR/USD
  assetClass: AssetClass;
  baseCurrency: string;
  quoteCurrency: string;
  /** Decimal places for prices (EURUSD = 5). From the registry, never hard-coded in UI. */
  pricePrecision: number;
  /** Decimal places for quantities. */
  qtyPrecision: number;
  tickSize: DecimalString;
  lotSize: DecimalString;
}

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing' | 'bracket' | 'oco';
export const ADVANCED_ORDER_TYPES: readonly OrderType[] = ['stop_limit', 'trailing', 'bracket', 'oco'];
export const NOVICE_ORDER_TYPES: readonly OrderType[] = ['market', 'limit'];
export type TimeInForce = 'gtc' | 'day' | 'ioc' | 'fok';
export type OrderStatus = 'new' | 'working' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected';

export interface Order {
  id: string;
  clientOrderId: string;
  accountId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: DecimalString;
  limitPrice: DecimalString | null;
  stopPrice: DecimalString | null;
  tif: TimeInForce;
  status: OrderStatus;
  source: 'manual' | 'robot' | 'ai_draft';
  createdAt: string;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  qty: DecimalString;
  price: DecimalString;
  fee: DecimalString;
  slippage: DecimalString;
  ts: string;
}

export interface Position {
  accountId: string;
  symbol: string;
  qty: DecimalString; // signed
  avgPrice: DecimalString;
  unrealizedPnl: DecimalString;
  realizedPnl: DecimalString;
}

export interface Strategy {
  id: string;
  name: string;
  versionHash: string;
  ownerId: string;
  status: 'draft' | 'backtested' | 'paper' | 'paused' | 'live_pending';
}

/** In-memory money value: amount + ISO currency. */
export interface Money {
  amount: Decimal;
  currency: string;
}
