'use client';

import type { TradesBatch } from '@kora/domain';
import { formatPrice } from '@kora/ui';
import { useEffect, useState } from 'react';

import { formatClock, formatQty } from '@/lib/terminal/format';
import { useRegistry } from '@/lib/terminal/registry';
import { useTerminal } from '@/lib/terminal/store';

import { useMarket, useTerminalSettings } from '../TerminalContext';

type Print = TradesBatch['trades'][number];
const KEEP = 60;

/** Time and sales (B-210): prints from `trades:{symbol}`, newest first; aggressor side as ▲ buy / ▼ sell. */
export function TimeAndSalesPanel() {
  const store = useMarket();
  const symbol = useTerminal((s) => s.symbol);
  const spec = useRegistry((s) => s.instruments.get(symbol));
  const { timeDisplay } = useTerminalSettings();
  const [prints, setPrints] = useState<Print[]>([]);

  useEffect(() => {
    setPrints([]);
    return store.onTrades(symbol, (b) =>
      setPrints((p) => [...[...b.trades].reverse(), ...p].slice(0, KEEP)),
    );
  }, [store, symbol]);

  return (
    <div
      className="h-full overflow-auto"
      data-testid="time-and-sales"
      data-panel-root="trades"
      tabIndex={0}
      aria-label="Time and sales"
    >
      <table className="k-grid">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col" className="num">
              Price
            </th>
            <th scope="col" className="num">
              Size
            </th>
            <th scope="col">Side</th>
          </tr>
        </thead>
        <tbody>
          {prints.map((p) => (
            <tr key={`${p.tradeId}-${p.seq}`}>
              <td className="k-num">{formatClock(p.exchangeTs, timeDisplay)}</td>
              <td className={`num k-num k-dir--${p.side === 'buy' ? 'up' : 'down'}`}>
                {formatPrice(p.price, spec?.pricePrecision ?? 5)}
              </td>
              <td className="num k-num">{formatQty(p.qty, spec?.qtyPrecision ?? 2)}</td>
              <td className={`k-dir--${p.side === 'buy' ? 'up' : 'down'}`}>
                {p.side === 'buy' ? '▲ Buy' : '▼ Sell'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {prints.length === 0 ? <p className="text-muted text-xs px-2">Waiting for prints…</p> : null}
    </div>
  );
}
