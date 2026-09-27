'use client';

import { dec, type FillDto, type PositionDto } from '@kora/domain';
import { Banner, Panel, formatMoney, formatPrice } from '@kora/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { useAccount } from '@/lib/account';
import { api } from '@/lib/api-browser';
import { formatClock, formatQty } from '@/lib/terminal/format';
import { useRegistry } from '@/lib/terminal/registry';

const POLL_MS = 5000;

function signedClass(v: string | null): string {
  if (!v) return '';
  const d = dec(v);
  return d.isZero() ? '' : d.isNegative() ? 'k-dir--down' : 'k-dir--up';
}

function Arrow({ v }: { v: string | null }) {
  if (!v || dec(v).isZero()) return null;
  return <span aria-hidden="true">{dec(v).isNegative() ? '▼ ' : '▲ '}</span>;
}

/**
 * Portfolio (IRTC R5-11): the paper account's equity and P&L by period, open positions and recent
 * fills, straight from the engine (GET /accounts/me, /positions, /fills; REST, refreshed every 5 s).
 * Every figure traces to the paper engine; nothing here is computed in the browser except display.
 */
export function Portfolio() {
  const { account, error } = useAccount();
  const [positions, setPositions] = useState<PositionDto[] | null>(null);
  const [fills, setFills] = useState<FillDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const instruments = useRegistry((s) => s.instruments);
  const loadRegistry = useRegistry((s) => s.load);

  useEffect(() => {
    void loadRegistry();
    let alive = true;
    const load = () =>
      Promise.all([api.positions(), api.fills({ limit: 50 })])
        .then(([p, f]) => {
          if (!alive) return;
          setPositions(p.positions);
          setFills(f.fills);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [loadRegistry]);

  const ccy = account?.baseCurrency ?? 'USD';
  const money = (v: string | null | undefined, signed = false) =>
    v ? formatMoney(v, ccy, { signed }) : '—';
  const periods: Array<[string, string | undefined, string]> = [
    ['Today', account?.dayPnl, 'portfolio-day'],
    ['This week', account?.weekPnl, 'portfolio-week'],
    ['This month', account?.monthPnl, 'portfolio-month'],
  ];

  return (
    <div className="flex flex-col gap-4 p-3 min-w-0" data-testid="portfolio">
      <h1 className="text-lg m-0">Portfolio</h1>
      <p className="m-0 text-xs text-muted">
        PAPER account · SIMULATED market data. Figures from the paper engine, refreshed every 5 s.
      </p>
      {error || failed ? (
        <Banner tone="warn" title="Some figures could not be refreshed.">
          The last figures are shown; they may be out of date.
        </Banner>
      ) : null}

      <Panel title="Account">
        <dl
          className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3 m-0"
          data-testid="portfolio-equity"
        >
          <div>
            <dt className="k-label">Equity</dt>
            <dd className="m-0 k-num text-base">{money(account?.equity)}</dd>
          </div>
          <div>
            <dt className="k-label">Cash</dt>
            <dd className="m-0 k-num">{money(account?.cash)}</dd>
          </div>
          <div>
            <dt className="k-label">Unrealized P&amp;L</dt>
            <dd className={`m-0 k-num ${signedClass(account?.unrealizedPnl ?? null)}`}>
              <Arrow v={account?.unrealizedPnl ?? null} />
              {money(account?.unrealizedPnl, true)}
            </dd>
          </div>
          {periods.map(([label, v, id]) => (
            <div key={id}>
              <dt className="k-label">P&amp;L {label.toLowerCase()}</dt>
              <dd className={`m-0 k-num ${signedClass(v ?? null)}`} data-testid={id}>
                <Arrow v={v ?? null} />
                {money(v, true)}
              </dd>
            </div>
          ))}
          <div>
            <dt className="k-label">Margin used</dt>
            <dd className="m-0 k-num">
              {account ? `${money(account.marginUsed)} · ${account.marginUsedPct}%` : '—'}
            </dd>
          </div>
          <div>
            <dt className="k-label">Gross exposure</dt>
            <dd className="m-0 k-num">
              {account ? `${money(account.grossExposure)} · ${account.leverage}×` : '—'}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title={`Open positions${positions ? ` (${positions.length})` : ''}`}>
        {positions === null ? (
          <p className="m-0 text-muted">Loading…</p>
        ) : positions.length === 0 ? (
          <p className="m-0 text-muted">
            No open positions. <Link href="/terminal">Open the terminal</Link> to trade.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse" data-testid="portfolio-positions">
              <caption className="k-sr-only">Open positions</caption>
              <thead>
                <tr className="text-left text-muted text-xs">
                  <th scope="col" className="py-1 pr-3">
                    Instrument
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Side
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    Qty
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    Avg price
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    Mark
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    Unrealized ({ccy})
                  </th>
                  <th scope="col" className="py-1 text-right">
                    Exposure ({ccy})
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const spec = instruments.get(p.symbol);
                  const pp = spec?.pricePrecision ?? 5;
                  const long = !p.qty.startsWith('-');
                  return (
                    <tr key={p.symbol} className="border-t border-border">
                      <td className="py-1 pr-3">
                        <Link href={`/terminal?symbol=${p.symbol}`}>
                          {spec?.displayName ?? p.symbol}
                        </Link>
                      </td>
                      <td className={`py-1 pr-3 ${long ? 'k-dir--up' : 'k-dir--down'}`}>
                        {long ? '▲ Long' : '▼ Short'}
                      </td>
                      <td className="py-1 pr-3 text-right k-num">
                        {formatQty(p.qty, spec?.qtyPrecision ?? 4)}
                      </td>
                      <td className="py-1 pr-3 text-right k-num">{formatPrice(p.avgPrice, pp)}</td>
                      <td className="py-1 pr-3 text-right k-num">
                        {p.markPrice ? formatPrice(p.markPrice, pp) : '—'}
                        {p.stale ? <span className="text-warn text-xs"> Stale</span> : null}
                      </td>
                      <td className={`py-1 pr-3 text-right k-num ${signedClass(p.unrealizedPnl)}`}>
                        {p.unrealizedPnl
                          ? formatMoney(p.unrealizedPnl, ccy, { signed: true }).replace(
                              ` ${ccy}`,
                              '',
                            )
                          : '—'}
                      </td>
                      <td className="py-1 text-right k-num">
                        {p.notional ? formatMoney(p.notional, ccy).replace(` ${ccy}`, '') : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recent fills">
        {fills === null ? (
          <p className="m-0 text-muted">Loading…</p>
        ) : fills.length === 0 ? (
          <p className="m-0 text-muted">No fills yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse" data-testid="portfolio-fills">
              <caption className="k-sr-only">Recent fills</caption>
              <thead>
                <tr className="text-left text-muted text-xs">
                  <th scope="col" className="py-1 pr-3">
                    Time (UTC)
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Symbol
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Side
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    Qty
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    Price
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right">
                    Costs ({ccy})
                  </th>
                  <th scope="col" className="py-1 text-right">
                    Realized ({ccy})
                  </th>
                </tr>
              </thead>
              <tbody>
                {fills.map((f) => {
                  const spec = instruments.get(f.symbol);
                  const costs = dec(f.commission)
                    .add(dec(f.spreadCost))
                    .add(dec(f.fxConversionCost))
                    .toFixed();
                  return (
                    <tr key={f.id} className="border-t border-border">
                      <td className="py-1 pr-3 k-num">{formatClock(f.ts, 'utc')}</td>
                      <td className="py-1 pr-3">{f.symbol}</td>
                      <td className={`py-1 pr-3 ${f.side === 'buy' ? 'k-dir--up' : 'k-dir--down'}`}>
                        {f.side === 'buy' ? '▲ Buy' : '▼ Sell'}
                      </td>
                      <td className="py-1 pr-3 text-right k-num">
                        {formatQty(f.qty, spec?.qtyPrecision ?? 4)}
                      </td>
                      <td className="py-1 pr-3 text-right k-num">
                        {formatPrice(f.price, spec?.pricePrecision ?? 5)}
                      </td>
                      <td className="py-1 pr-3 text-right k-num">
                        {formatMoney(costs, ccy).replace(` ${ccy}`, '')}
                      </td>
                      <td className={`py-1 text-right k-num ${signedClass(f.realizedPnl)}`}>
                        {formatMoney(f.realizedPnl, ccy, { signed: true }).replace(` ${ccy}`, '')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
