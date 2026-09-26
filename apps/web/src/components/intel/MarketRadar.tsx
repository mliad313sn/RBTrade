'use client';

import '../ai/ai.css';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { useShell } from '@/components/shell/ShellContext';
import {
  arrow,
  intelApi,
  signed,
  TREND_LABELS,
  trendArrow,
  type AlertsData,
  type RadarData,
  type TrendCard,
  type TrendKind,
} from '@/lib/intel/client';

import { TrendCardView } from './TrendCardView';

const REGIONS = [
  ['', 'All regions'],
  ['americas', 'Americas'],
  ['europe', 'Europe'],
  ['africa', 'Africa'],
  ['asia', 'Asia'],
  ['oceania', 'Oceania'],
  ['global', 'Global OTC'],
] as const;
const CLASSES = ['', 'equity', 'etf', 'bond', 'future', 'option', 'fx', 'metal', 'energy', 'agri', 'crypto', 'index', 'cfd', 'fund'];
const SECTORS = [
  '',
  'technology',
  'communication',
  'consumer',
  'financials',
  'energy',
  'materials',
  'industrials',
  'broad_market',
  'rates',
  'currencies',
  'metals',
  'agriculture',
  'crypto',
  'multi_asset',
];
const HORIZONS = ['1d', '1w', '1m'];

/** Heat-map background from the group's mean momentum z (sign + strength); text always carries ▲▼. */
function heat(m: number | null): string {
  if (m === null) return 'var(--k-panel)';
  const a = Math.min(0.35, Math.abs(m) / 5);
  const base = m >= 0 ? 'var(--k-up)' : 'var(--k-down)';
  return `color-mix(in srgb, ${base} ${Math.round(a * 100)}%, var(--k-panel))`;
}

/**
 * Pro "Market Radar" (goal 07B §6): filter by region, asset class and sector; heat map; ranked
 * emerging trends; trend card with drivers, news, invalidation and a grounded summary; server-
 * evaluated alerts; "Draft to ticket" and "Send to Robot builder". Everything is SIMULATED.
 */
export function MarketRadar() {
  const router = useRouter();
  const { me } = useShell();
  const canDraft = me.roles.includes('trader');
  const canBuild = me.capabilities.robotBuilder;
  const [region, setRegion] = useState('');
  const [assetClass, setAssetClass] = useState('');
  const [sector, setSector] = useState('');
  const [win, setWin] = useState<'day' | 'week'>('week');
  const [groupBy, setGroupBy] = useState<'region' | 'assetClass' | 'sector'>('region');
  const [data, setData] = useState<RadarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [horizon, setHorizon] = useState('1d');
  const [card, setCard] = useState<TrendCard | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertsData | null>(null);
  const [alertKinds, setAlertKinds] = useState<TrendKind[]>(['up', 'breakout_up']);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await intelApi.radar({ region, assetClass, sector, window: win, groupBy }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [region, assetClass, sector, win, groupBy]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAlerts = useCallback(async () => {
    try {
      setAlerts(await intelApi.alerts());
    } catch {
      setAlerts(null);
    }
  }, []);
  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  useEffect(() => {
    if (!selected) return;
    setCard(null);
    setCardError(null);
    intelApi
      .card(selected, horizon)
      .then(setCard)
      .catch((e: Error) => setCardError(e.message));
  }, [selected, horizon]);

  const onDraft = (draftId: string, symbol: string) => {
    router.push(`/terminal?symbol=${encodeURIComponent(symbol)}&aiDraft=${draftId}`);
  };

  const addAlert = async () => {
    setAlertMsg(null);
    try {
      await intelApi.createAlert(`Radar ${region || 'all'} ${alertKinds.join('/')}`, {
        trendKinds: alertKinds,
        ...(region ? { region: region as never } : {}),
        ...(assetClass ? { assetClass } : {}),
        ...(sector ? { sector } : {}),
        minScore: 0.5,
      });
      setAlertMsg('Alert saved. The server checks it after every scan.');
      await loadAlerts();
    } catch (e) {
      setAlertMsg((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3" data-testid="market-radar">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="m-0 font-display text-xl">Market Radar</h1>
          <p className="m-0 text-xs text-muted">
            Scanner over the SIMULATED global universe · {data?.timeframe ?? '1h'} bars · last scan{' '}
            {data?.scannedAt ? `${data.scannedAt.slice(0, 16).replace('T', ' ')} UTC` : 'not run yet'} · {data?.instruments ?? 0} instruments
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2 text-xs" aria-label="Radar filters" onSubmit={(e) => e.preventDefault()}>
          <label className="flex flex-col gap-0.5">
            Region
            <select value={region} onChange={(e) => setRegion(e.target.value)} data-testid="radar-region" className="rounded border border-border bg-panel px-2 py-1">
              {REGIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            Asset class
            <select value={assetClass} onChange={(e) => setAssetClass(e.target.value)} data-testid="radar-asset-class" className="rounded border border-border bg-panel px-2 py-1">
              {CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c || 'All asset classes'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            Sector
            <select value={sector} onChange={(e) => setSector(e.target.value)} data-testid="radar-sector" className="rounded border border-border bg-panel px-2 py-1">
              {SECTORS.map((c) => (
                <option key={c} value={c}>
                  {c ? c.replace(/_/g, ' ') : 'All sectors'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            Window
            <select value={win} onChange={(e) => setWin(e.target.value as 'day' | 'week')} data-testid="radar-window" className="rounded border border-border bg-panel px-2 py-1">
              <option value="day">Past day</option>
              <option value="week">Past week</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            Heat map by
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as 'region' | 'assetClass' | 'sector')}
              data-testid="radar-group-by"
              className="rounded border border-border bg-panel px-2 py-1"
            >
              <option value="region">Region</option>
              <option value="assetClass">Asset class</option>
              <option value="sector">Sector</option>
            </select>
          </label>
        </form>
      </header>

      {error && (
        <p className="m-0 text-sm text-warn" role="alert">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <section aria-labelledby="heat-h" className="rounded border border-border bg-panel p-2">
            <h2 id="heat-h" className="m-0 mb-2 text-xs font-semibold uppercase text-muted">
              Heat map · mean momentum z by {groupBy === 'assetClass' ? 'asset class' : groupBy}
            </h2>
            <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 md:grid-cols-3" data-testid="radar-heatmap">
              {(data?.heatMap ?? []).map((c) => (
                <li
                  key={c.key}
                  className="rounded border border-border p-2 text-xs"
                  style={{ background: heat(c.meanMomentumZ) }}
                  data-testid="heat-cell"
                  data-key={c.key}
                >
                  <div className="font-semibold">{c.label}</div>
                  <div className="k-num">
                    {arrow(c.meanMomentumZ)} {signed(c.meanMomentumZ)} · {c.instruments} instr.
                  </div>
                  <div>
                    ▲ {c.up} / ▼ {c.down} · trending {c.trending}
                  </div>
                  {c.top && (
                    <button type="button" className="mt-1 underline" onClick={() => setSelected(c.top!.symbol)}>
                      Top: {c.top.symbol} ({signed(c.top.momentumZ)})
                    </button>
                  )}
                </li>
              ))}
              {data && !data.heatMap.length && <li className="text-xs text-muted">Nothing scanned for these filters yet.</li>}
            </ul>
          </section>

          <section aria-labelledby="trends-h" className="rounded border border-border bg-panel p-2">
            <h2 id="trends-h" className="m-0 mb-2 text-xs font-semibold uppercase text-muted">
              Emerging trends ({win === 'day' ? 'past day' : 'past week'})
            </h2>
            {data?.trends.length ? (
              <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm" data-testid="radar-trends">
                {data.trends.map((t) => (
                  <li key={t.symbol}>
                    <button
                      type="button"
                      onClick={() => setSelected(t.symbol)}
                      aria-pressed={selected === t.symbol}
                      className={`grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1 text-left ${selected === t.symbol ? 'bg-raised' : 'hover:bg-raised'}`}
                      data-testid="radar-trend"
                      data-symbol={t.symbol}
                    >
                      <span className="k-num text-muted">#{t.rank}</span>
                      <span className="truncate">
                        <strong>{t.symbol}</strong> <span className="text-muted">{t.name}</span>
                      </span>
                      <span className="k-num text-xs">
                        {trendArrow(t.kind)} {TREND_LABELS[t.kind]} · score {t.score.toFixed(2)} · mom z {signed(t.momentumZ)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="m-0 text-xs text-muted">No emerging trend labels for these filters. Biggest movers:</p>
            )}
            {data && (
              <p className="m-0 mt-2 text-xs text-muted" data-testid="radar-movers">
                Movers:{' '}
                {data.movers.map((m, i) => (
                  <span key={m.symbol}>
                    {i ? ', ' : ''}
                    <button type="button" className="underline" onClick={() => setSelected(m.symbol)}>
                      {m.symbol}
                    </button>{' '}
                    {arrow(m.momentumZ)} {signed(m.momentumZ)}
                  </span>
                ))}
              </p>
            )}
            <p className="m-0 mt-2 text-xs text-muted">{data?.method}</p>
          </section>

          <section aria-labelledby="alerts-h" className="rounded border border-border bg-panel p-2">
            <h2 id="alerts-h" className="m-0 mb-2 text-xs font-semibold uppercase text-muted">
              Alerts (evaluated on the server after every scan)
            </h2>
            <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0 text-xs">
              <legend className="sr-only">Trend kinds</legend>
              {(Object.keys(TREND_LABELS) as TrendKind[]).map((k) => (
                <label key={k} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={alertKinds.includes(k)}
                    onChange={(e) => setAlertKinds((xs) => (e.target.checked ? [...xs, k] : xs.filter((x) => x !== k)))}
                  />
                  {TREND_LABELS[k]}
                </label>
              ))}
              <button type="button" className="ai-strip__btn" disabled={!alertKinds.length} onClick={() => void addAlert()} data-testid="radar-add-alert">
                Alert me for the current filters
              </button>
            </fieldset>
            {alertMsg && (
              <p className="m-0 mt-1 text-xs" role="status">
                {alertMsg}
              </p>
            )}
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-xs" data-testid="radar-alerts">
              {(alerts?.alerts ?? []).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span>
                    {a.name} · min score {a.rule.minScore}
                  </span>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void intelApi.deleteAlert(a.id).then(loadAlerts)}
                    aria-label={`Delete alert ${a.name}`}
                  >
                    Delete
                  </button>
                </li>
              ))}
              {(alerts?.events ?? []).slice(0, 10).map((e) => (
                <li key={e.id} className="text-muted" data-testid="radar-alert-event">
                  {e.createdAt.slice(0, 16).replace('T', ' ')} UTC · {e.symbol} · {String(e.detail.kind ?? '')}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside aria-label="Trend card" className="min-w-0 rounded border border-border bg-panel p-3">
          {!selected && <p className="m-0 text-sm text-muted">Select a trend, a heat-map leader or a mover to open its card.</p>}
          {selected && (
            <div className="mb-2 flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1">
                Horizon
                <select value={horizon} onChange={(e) => setHorizon(e.target.value)} data-testid="trend-horizon" className="rounded border border-border bg-panel px-2 py-1">
                  {HORIZONS.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {cardError && (
            <p className="m-0 text-sm text-warn" role="alert">
              {cardError}
            </p>
          )}
          {selected && !card && !cardError && <p className="m-0 text-sm text-muted">Loading the trend card…</p>}
          {card && <TrendCardView key={`${card.symbol}-${card.horizon}`} card={card} canDraft={canDraft} canBuild={canBuild} onDraft={onDraft} />}
        </aside>
      </div>
      <p className="m-0 text-xs text-muted">
        Patterns and forecasts on SIMULATED data. A probability appears only when the calibration table shows skill after costs.{' '}
        <a href="/reliability" className="underline">
          Track record
        </a>
        . {data?.disclaimer ?? 'Not investment advice.'}
      </p>
    </div>
  );
}
