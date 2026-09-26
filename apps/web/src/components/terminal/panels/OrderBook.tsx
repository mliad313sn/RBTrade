'use client';

import { dec, type DepthSnapshot } from '@kora/domain';
import { formatDecimal, formatPrice } from '@kora/ui';
import { useEffect, useRef, useState } from 'react';

import { formatSpread } from '@/lib/terminal/format';
import { useRegistry } from '@/lib/terminal/registry';
import { useTerminal } from '@/lib/terminal/store';

import { useMarket } from '../TerminalContext';

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

/**
 * Order book / depth (goal 04): 10 levels per side from the `depth:{symbol}` channel, cumulative
 * size bars, spread and mid. Clicking (or Enter on) a level fills the ticket's limit price.
 */
export function OrderBookPanel({ onTitleRight }: { onTitleRight?: (t: string) => void }) {
  const store = useMarket();
  const symbol = useTerminal((s) => s.symbol);
  const prefill = useTerminal((s) => s.prefillTicket);
  const spec = useRegistry((s) => s.instruments.get(symbol));
  const [view, setView] = useState<BookView | null>(null);
  const prevMid = useRef<string | null>(null);
  const [midDir, setMidDir] = useState<'up' | 'down' | 'flat'>('flat');

  useEffect(() => {
    setView(null);
    prevMid.current = null;
    return store.onDepth(symbol, (d) => {
      const v = bookView(d, 10);
      if (v.mid && prevMid.current && v.mid !== prevMid.current) setMidDir(dec(v.mid).gt(dec(prevMid.current)) ? 'up' : 'down');
      prevMid.current = v.mid;
      setView(v);
    });
  }, [store, symbol]);

  const precision = spec?.pricePrecision ?? 5;
  const qtyPlaces = Math.min(spec?.qtyPrecision ?? 2, 2);
  const spreadText = view?.spread && spec && view.asks[0] && view.bids[0] ? formatSpread(view.bids[0].price, view.asks[0].price, spec) : '—';
  useEffect(() => {
    onTitleRight?.(`spread ${spreadText}`);
  }, [spreadText, onTitleRight]);

  const fmtSize = (s: string) => {
    // Sizes shown in thousands for large FX books (prototype: 4.0 = 4.0M), otherwise at qty precision.
    const n = dec(s);
    return n.gte(1_000_000) ? `${formatDecimal(n.div(1_000_000), 1)}M` : n.gte(10_000) ? `${formatDecimal(n.div(1000), 1)}k` : formatDecimal(n, qtyPlaces);
  };

  const level = (side: 'bid' | 'ask', l: BookLevel, i: number) => (
    <li key={`${side}-${l.price}`}>
      <button
        type="button"
        className={`ob-row ob-row--${side}`}
        style={{ ['--ob-depth' as string]: `${Math.round(l.depth * 100)}%` }}
        onClick={() => prefill({ symbol, type: 'limit', side: side === 'ask' ? 'buy' : 'sell', limitPrice: l.price, origin: 'order_book' })}
        aria-label={`${side === 'ask' ? 'Ask' : 'Bid'} ${formatPrice(l.price, precision)}, size ${fmtSize(l.size)}. Use as limit price.`}
        data-testid={`ob-${side}-${i}`}
      >
        <span className="ob-price k-num">{formatPrice(l.price, precision)}</span>
        <span className="ob-size k-num">{fmtSize(l.size)}</span>
        <span className="ob-total k-num">{fmtSize(l.total)}</span>
      </button>
    </li>
  );

  return (
    <div className="ob h-full flex flex-col min-h-0" data-testid="order-book" data-panel-root="orderbook" tabIndex={-1}>
      <div className="ob-head" aria-hidden="true">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>
      {!view ? (
        <p className="text-muted text-xs px-2">Waiting for depth…</p>
      ) : (
        <div className="ob-body">
          <ol className="ob-side ob-side--asks" aria-label="Asks, best at the bottom">
            {[...view.asks].reverse().map((l, i) => level('ask', l, view.asks.length - 1 - i))}
          </ol>
          <div className="ob-mid" data-testid="ob-mid">
            <span className={`k-num ob-mid-price k-dir--${midDir}`}>
              {view.mid ? formatPrice(dec(view.mid).toDecimalPlaces(precision).toFixed(precision), precision) : '—'} {midDir === 'up' ? '▲' : midDir === 'down' ? '▼' : ''}
            </span>
            <span className="text-muted text-[10px] uppercase">Mid</span>
          </div>
          <ol className="ob-side ob-side--bids" aria-label="Bids, best at the top">
            {view.bids.map((l, i) => level('bid', l, i))}
          </ol>
        </div>
      )}
    </div>
  );
}
