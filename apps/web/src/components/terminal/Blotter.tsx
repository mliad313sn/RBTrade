'use client';

import type { FillDto, OrderDto, PositionDto } from '@kora/sdk';
import { Button, Tabs, formatMoney } from '@kora/ui';
import { useCallback, useEffect, useState } from 'react';

import { refreshAccount } from '@/lib/account';
import { api } from '@/lib/api-browser';

const REFRESH = 'kora:blotter-refresh';

/**
 * Minimal blotter over the goal 03 REST API (positions, open orders, fills) with close and cancel.
 * Polls, so it works without the WebSocket; the full blotter (streaming, sorting, amend in place) is
 * goal 04.
 */
export function Blotter() {
  const [positions, setPositions] = useState<PositionDto[]>([]);
  const [currency, setCurrency] = useState('USD');
  const [orders, setOrders] = useState<OrderDto[]>([]);
  const [fills, setFills] = useState<FillDto[]>([]);

  const load = useCallback(() => {
    api
      .positions()
      .then((r) => {
        setPositions(r.positions);
        setCurrency(r.currency);
      })
      .catch(() => undefined);
    api
      .orders({ status: 'open' })
      .then((r) => setOrders(r.orders))
      .catch(() => undefined);
    api
      .fills({ limit: 50 })
      .then((r) => setFills(r.fills))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    window.addEventListener(REFRESH, load);
    window.addEventListener('kora:account-refresh', load);
    return () => {
      clearInterval(t);
      window.removeEventListener(REFRESH, load);
      window.removeEventListener('kora:account-refresh', load);
    };
  }, [load]);

  const after = () => {
    load();
    refreshAccount();
  };

  const empty = (what: string) => <p className="text-muted text-sm px-2">No {what}.</p>;
  const th = 'text-left font-normal text-muted px-2 py-1 text-[11px] uppercase';
  const td = 'px-2 py-1 k-num';

  return (
    <Tabs
      label="Blotter"
      items={[
        {
          value: 'positions',
          label: `Positions (${positions.length})`,
          content: positions.length ? (
            <table className="w-full text-xs" data-testid="blotter-positions">
              <thead>
                <tr>
                  {['Symbol', 'Side', 'Qty', 'Avg price', 'Mark', `Unrl. P&L (${currency})`, ''].map((h) => (
                    <th key={h} className={th} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const long = !p.qty.startsWith('-');
                  return (
                    <tr key={p.symbol}>
                      <td className="px-2 py-1 font-semibold">{p.symbol}</td>
                      <td className={`px-2 py-1 ${long ? 'text-up' : 'text-down'}`}>{long ? '▲ Long' : '▼ Short'}</td>
                      <td className={td}>{p.qty.replace('-', '')}</td>
                      <td className={td}>{p.avgPrice}</td>
                      <td className={td}>{p.markPrice ?? '—'}</td>
                      <td className={td}>{p.unrealizedPnl ? formatMoney(p.unrealizedPnl, currency, { signed: true }) : '—'}</td>
                      <td className="px-2 py-1 text-right">
                        <Button size="sm" onClick={() => void api.closePosition(p.symbol).then(after, after)} data-testid={`close-${p.symbol}`}>
                          Close
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            empty('open positions')
          ),
        },
        {
          value: 'orders',
          label: `Orders (${orders.length})`,
          content: orders.length ? (
            <table className="w-full text-xs" data-testid="blotter-orders">
              <thead>
                <tr>
                  {['Symbol', 'Side', 'Type', 'Qty', 'Filled', 'Price', 'Status', ''].map((h) => (
                    <th key={h} className={th} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="px-2 py-1 font-semibold">{o.symbol}</td>
                    <td className={`px-2 py-1 ${o.side === 'buy' ? 'text-up' : 'text-down'}`}>{o.side === 'buy' ? '▲ Buy' : '▼ Sell'}</td>
                    <td className="px-2 py-1">{o.role === 'primary' ? o.type : o.role.replace('_', ' ')}</td>
                    <td className={td}>{o.qty}</td>
                    <td className={td}>{o.filledQty}</td>
                    <td className={td}>{o.limitPrice ?? o.stopPrice ?? 'market'}</td>
                    <td className="px-2 py-1">{o.status.replace('_', ' ')}</td>
                    <td className="px-2 py-1 text-right">
                      <Button size="sm" onClick={() => void api.cancelOrder(o.id).then(after, after)} data-testid={`cancel-${o.id}`}>
                        Cancel
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty('open orders')
          ),
        },
        {
          value: 'fills',
          label: 'Fills',
          content: fills.length ? (
            <table className="w-full text-xs" data-testid="blotter-fills">
              <thead>
                <tr>
                  {['Time (UTC)', 'Symbol', 'Side', 'Qty', 'Price', 'Slippage', `Fees (${currency})`].map((h) => (
                    <th key={h} className={th} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fills.map((f) => (
                  <tr key={f.id}>
                    <td className={td}>{f.ts.slice(11, 19)}</td>
                    <td className="px-2 py-1 font-semibold">{f.symbol}</td>
                    <td className={`px-2 py-1 ${f.side === 'buy' ? 'text-up' : 'text-down'}`}>{f.side === 'buy' ? '▲ Buy' : '▼ Sell'}</td>
                    <td className={td}>{f.qty}</td>
                    <td className={td}>{f.price}</td>
                    <td className={td}>{f.slippage}</td>
                    <td className={td}>{formatMoney(f.commission, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty('fills yet')
          ),
        },
      ]}
    />
  );
}
