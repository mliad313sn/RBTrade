'use client';

import { assetClassLabel, type FeedStatus, type InstrumentSpec, type Quote } from '@kora/domain';
import { MarketDataSocket } from '@kora/sdk';
import { DirectionBadge, formatPrice } from '@kora/ui';
import { useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api-browser';
import { MAJORS, watchlistRow } from '@/lib/market-ws';

interface Row {
  spec: InstrumentSpec;
  quote: Quote | null;
  dayOpen: string | null;
}

/**
 * Minimal live watchlist (goal 02 wiring; the full terminal is goal 04). Quotes arrive over the
 * market data WebSocket (session cookie auth, ≤ 10 updates/s per symbol) and render at most 4×/s.
 * A stale quote shows a STALE badge (text, not colour alone).
 */
export function LiveWatchlist({ wsPort }: { wsPort: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<FeedStatus['state'] | 'connecting'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Map<string, Quote>());

  useEffect(() => {
    let cancelled = false;
    let socket: MarketDataSocket | null = null;
    const flush = setInterval(() => {
      if (pending.current.size === 0) return;
      const updates = pending.current;
      pending.current = new Map();
      setRows((rs) => rs.map((r) => (updates.has(r.spec.symbol) ? { ...r, quote: updates.get(r.spec.symbol)! } : r)));
    }, 250);
    (async () => {
      try {
        const [{ instruments }, { quotes }] = await Promise.all([api.instruments(), api.quotes(MAJORS)]);
        if (cancelled) return;
        const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
        setRows(
          MAJORS.filter((s) => bySymbol.has(s)).map((s) => {
            const q = quotes.find((x) => x.symbol === s);
            return { spec: bySymbol.get(s)!, quote: q?.quote ?? null, dayOpen: q?.dayOpen ?? null };
          }),
        );
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new MarketDataSocket({ url: `${proto}://${window.location.hostname}:${wsPort}/ws` });
        socket.status((s) => setStatus(s.state));
        for (const s of MAJORS) socket.quotes(s, (q) => pending.current.set(s, q));
        socket.connect();
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(flush);
      socket?.close();
    };
  }, [wsPort]);

  if (error) return <p className="m-0 text-sm text-muted">Market data unavailable: {error}</p>;
  return (
    <div data-testid="watchlist">
      <table className="w-full text-sm border-collapse">
        <caption className="text-left text-[10px] uppercase tracking-wider text-muted pb-1">
          Simulated feed · not market data · <span data-testid="feed-status">feed {status}</span>
        </caption>
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-muted">
            <th scope="col" className="text-left font-normal py-1">Symbol</th>
            <th scope="col" className="text-right font-normal py-1">Mid</th>
            <th scope="col" className="text-right font-normal py-1">Chg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ spec, quote, dayOpen }) => {
            const v = watchlistRow(quote, dayOpen, spec.pricePrecision);
            return (
              <tr key={spec.symbol} data-testid={`wl-${spec.symbol}`} data-stale={v.stale ? 'true' : 'false'} className="border-t border-border">
                <th scope="row" className="text-left font-semibold py-1">
                  {spec.displayName}
                  <span className="block text-[10px] font-normal text-muted">{assetClassLabel(spec.assetClass, spec.underlyingClass)}</span>
                </th>
                <td className={`text-right k-num py-1 ${v.stale ? 'text-muted' : ''}`} data-testid={`wl-${spec.symbol}-mid`}>
                  {v.mid ? formatPrice(v.mid, spec.pricePrecision) : '—'}
                  {v.stale ? (
                    <span className="ml-1 rounded border border-border px-1 text-[10px] font-semibold uppercase" title="No fresh quote within the staleness threshold">
                      Stale
                    </span>
                  ) : null}
                </td>
                <td className="text-right k-num py-1">{v.change ? <DirectionBadge value={v.change} format="percent" /> : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
