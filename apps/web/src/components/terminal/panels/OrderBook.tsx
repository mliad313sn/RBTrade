'use client';

import { dec } from '@kora/domain';
import { formatDecimal, formatPrice } from '@kora/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { formatSpread } from '@/lib/terminal/format';
import { useRegistry } from '@/lib/terminal/registry';
import { useTerminal } from '@/lib/terminal/store';
import { bookView, type BookLevel, type BookView } from '@/lib/terminal/views';

import { useMarket } from '../TerminalContext';

const LEVELS = 10;

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
  const [active, setActive] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const centred = useRef(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setView(null);
    prevMid.current = null;
    centred.current = false;
    return store.onDepth(symbol, (d) => {
      const v = bookView(d, LEVELS);
      if (v.mid && prevMid.current && v.mid !== prevMid.current)
        setMidDir(dec(v.mid).gt(dec(prevMid.current)) ? 'up' : 'down');
      prevMid.current = v.mid;
      setView(v);
    });
  }, [store, symbol]);

  // Goal 10 chaos finding: mark the book stale when the symbol's quote is stale (feed down).
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setStale(false);
    return store.onQuote(symbol, (q) => setStale(!!q.stale));
  }, [store, symbol]);

  useEffect(() => {
    const b = bodyRef.current;
    if (!view || !b || centred.current) return;
    centred.current = true;
    b.scrollTop = Math.max(0, (b.scrollHeight - b.clientHeight) / 2);
  }, [view]);

  const precision = spec?.pricePrecision ?? 5;
  const qtyPlaces = Math.min(spec?.qtyPrecision ?? 2, 2);
  const spreadText =
    view?.spread && spec && view.asks[0] && view.bids[0]
      ? formatSpread(view.bids[0].price, view.asks[0].price, spec)
      : '—';
  useEffect(() => {
    onTitleRight?.(stale ? 'Stale' : `spread ${spreadText}`);
  }, [spreadText, stale, onTitleRight]);

  const fmtSize = (s: string) => {
    // Sizes shown in thousands for large FX books (prototype: 4.0 = 4.0M), otherwise at qty precision.
    const n = dec(s);
    return n.gte(1_000_000)
      ? `${formatDecimal(n.div(1_000_000), 1)}M`
      : n.gte(10_000)
        ? `${formatDecimal(n.div(1000), 1)}k`
        : formatDecimal(n, qtyPlaces);
  };

  const asksShown = view ? [...view.asks].reverse() : [];
  const all = view
    ? [
        ...asksShown.map((l, i) => ({ side: 'ask' as const, l, i: view.asks.length - 1 - i })),
        ...view.bids.map((l, i) => ({ side: 'bid' as const, l, i })),
      ]
    : [];
  const applyLevel = (side: 'bid' | 'ask', l: BookLevel) =>
    prefill({
      symbol,
      type: 'limit',
      side: side === 'ask' ? 'buy' : 'sell',
      limitPrice: l.price,
      origin: 'order_book',
    });
  const activeIndex = Math.min(active ?? asksShown.length, Math.max(0, all.length - 1));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!all.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(
        Math.max(0, Math.min(all.length - 1, activeIndex + (e.key === 'ArrowDown' ? 1 : -1))),
      );
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const x = all[activeIndex];
      if (x) applyLevel(x.side, x.l);
    }
  };

  // Levels are options of one listbox (a single tab stop, arrow keys choose, Enter uses the price);
  // the same limit price can always be typed in the ticket.
  const level = (side: 'bid' | 'ask', l: BookLevel, i: number, idx: number) => (
    <li
      key={`${side}-${i}`}
      id={`ob-opt-${idx}`}
      role="option"
      aria-selected={idx === activeIndex}
      className={`ob-row ob-row--${side} ${idx === activeIndex && focused ? 'is-active' : ''}`}
      style={{ ['--ob-depth' as string]: l.depth.toFixed(3) }}
      onClick={() => {
        setActive(idx);
        applyLevel(side, l);
      }}
      aria-label={`${side === 'ask' ? 'Ask' : 'Bid'} ${formatPrice(l.price, precision)}, size ${fmtSize(l.size)}`}
      data-testid={`ob-${side}-${i}`}
    >
      <span className="ob-price k-num">{formatPrice(l.price, precision)}</span>
      <span className="ob-size k-num">{fmtSize(l.size)}</span>
      <span className="ob-total k-num">{fmtSize(l.total)}</span>
    </li>
  );

  return (
    <div
      className="ob h-full flex flex-col min-h-0"
      data-testid="order-book"
      data-panel-root="orderbook"
      data-stale={stale ? 'true' : 'false'}
      tabIndex={-1}
    >
      {stale ? (
        <p className="m-0 px-2 text-xs text-warn" role="status" data-testid="order-book-stale">
          ⚠ Stale: last depth before the feed stopped
        </p>
      ) : null}
      <div className="ob-head" aria-hidden="true">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>
      {!view ? (
        <p className="text-muted text-xs px-2">Waiting for depth…</p>
      ) : (
        <div
          ref={bodyRef}
          className="ob-body"
          role="listbox"
          tabIndex={0}
          aria-label="Order book levels: arrow keys choose a level, Enter uses its price as the ticket limit price"
          aria-activedescendant={`ob-opt-${activeIndex}`}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        >
          <ol className="ob-side ob-side--asks" role="group" aria-label="Asks, best at the bottom">
            {Array.from({ length: LEVELS - asksShown.length }, (_, k) => (
              <li key={`pad-a-${k}`} className="ob-row ob-row--pad" aria-hidden="true" />
            ))}
            {asksShown.map((l, i) => level('ask', l, view.asks.length - 1 - i, i))}
          </ol>
          <div className="ob-mid" data-testid="ob-mid" role="presentation">
            <span className={`k-num ob-mid-price k-dir--${midDir}`}>
              {view.mid
                ? formatPrice(
                    dec(view.mid).toDecimalPlaces(precision).toFixed(precision),
                    precision,
                  )
                : '—'}{' '}
              {midDir === 'up' ? '▲' : midDir === 'down' ? '▼' : ''}
            </span>
            <span className="text-muted text-[10px] uppercase">Mid</span>
          </div>
          <ol className="ob-side ob-side--bids" role="group" aria-label="Bids, best at the top">
            {view.bids.map((l, i) => level('bid', l, i, asksShown.length + i))}
            {Array.from({ length: LEVELS - view.bids.length }, (_, k) => (
              <li key={`pad-b-${k}`} className="ob-row ob-row--pad" aria-hidden="true" />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
