import { dec, type DepthSnapshot, type OrderDto, type PositionDto, type Quote } from '@kora/domain';
import type { InstrumentDto } from '@kora/sdk';
import { formatPercent, formatPrice } from '@kora/ui';

import { displayDirection, formatSpread, midOf } from './format';

/** Pure view models for the terminal panels (unit-tested in views.test.ts). */

export interface WatchRowView {
  /** Mid at registry precision (plain decimal string). */
  mid: string;
  last: string;
  change: string | null;
  dir: 'up' | 'down' | 'flat';
  spread: string;
}

/** Pure row computation (decimals at registry precision). Exported for tests. */
export function watchRowView(
  q: Pick<Quote, 'bid' | 'ask'>,
  dayOpen: string | null | undefined,
  spec: Pick<InstrumentDto, 'pricePrecision' | 'pipSize' | 'tickSize'>,
): WatchRowView {
  const mid = midOf(q.bid, q.ask, spec.pricePrecision);
  let change: string | null = null;
  let dir: WatchRowView['dir'] = 'flat';
  if (dayOpen && !dec(dayOpen).isZero()) {
    const ratio = dec(mid).sub(dec(dayOpen)).div(dec(dayOpen));
    // IRTC R5-19: the direction of the change as shown (2 decimals of %), so "0.00%" has no ▲/▼.
    dir = displayDirection(ratio.mul(100).toFixed(), 2);
    change = formatPercent(ratio);
  }
  return {
    mid,
    last: formatPrice(mid, spec.pricePrecision),
    change,
    dir,
    spread: formatSpread(q.bid, q.ask, spec),
  };
}

export interface BookLevel {
  price: string;
  size: string;
  total: string;
  /** Cumulative size as a share of the deepest side (0–1), for the bar. */
  depth: number;
}

export interface BookView {
  asks: BookLevel[];
  bids: BookLevel[];
  mid: string | null;
  spread: string | null;
}

/** Cumulative levels (Decimal sums), best first, bars scaled to the larger cumulative side. Exported for tests. */
export function bookView(d: Pick<DepthSnapshot, 'bids' | 'asks'>, levels = 10): BookView {
  const cum = (side: Array<[string, string]>) => {
    let run = dec(0);
    return side.slice(0, levels).map(([price, size]) => {
      run = run.add(dec(size));
      return { price, size, total: run.toFixed() };
    });
  };
  const bids = cum(d.bids);
  const asks = cum(d.asks);
  const max = Math.max(Number(bids.at(-1)?.total ?? 0), Number(asks.at(-1)?.total ?? 0)) || 1; // bar width only
  const withDepth = (xs: typeof bids) => xs.map((x) => ({ ...x, depth: Number(x.total) / max }));
  const bestBid = d.bids[0]?.[0];
  const bestAsk = d.asks[0]?.[0];
  return {
    bids: withDepth(bids),
    asks: withDepth(asks),
    mid: bestBid && bestAsk ? dec(bestBid).add(dec(bestAsk)).div(2).toFixed() : null,
    spread: bestBid && bestAsk ? dec(bestAsk).sub(dec(bestBid)).toFixed() : null,
  };
}

/** Price and field an order line represents (null = not drawn). */
export function orderLine(
  o: Pick<OrderDto, 'execType' | 'limitPrice' | 'stopPrice' | 'status'>,
): { price: string; field: 'limitPrice' | 'stopPrice'; draggable: boolean } | null {
  if (!['working', 'partially_filled', 'accepted', 'new'].includes(o.status)) return null;
  if (o.execType === 'limit' && o.limitPrice)
    return { price: o.limitPrice, field: 'limitPrice', draggable: true };
  if ((o.execType === 'stop' || o.execType === 'stop_limit') && o.stopPrice)
    return { price: o.stopPrice, field: 'stopPrice', draggable: true };
  if (o.execType === 'trailing' && o.stopPrice)
    return { price: o.stopPrice, field: 'stopPrice', draggable: false };
  return null;
}

/** Protective (reduce-only, opposite side) orders per symbol → stop and target columns. */
export function protectiveLevels(
  orders: OrderDto[],
  p: Pick<PositionDto, 'symbol' | 'qty'>,
): { stop: OrderDto | null; target: OrderDto | null } {
  const long = !p.qty.startsWith('-');
  const exitSide = long ? 'sell' : 'buy';
  const mine = orders.filter(
    (o) =>
      o.symbol === p.symbol &&
      o.side === exitSide &&
      (o.reduceOnly || o.role === 'stop_loss' || o.role === 'take_profit' || o.role === 'oco_leg'),
  );
  return {
    stop:
      mine.find(
        (o) =>
          (o.execType === 'stop' || o.execType === 'stop_limit' || o.execType === 'trailing') &&
          o.stopPrice,
      ) ?? null,
    target: mine.find((o) => o.execType === 'limit' && o.limitPrice) ?? null,
  };
}
