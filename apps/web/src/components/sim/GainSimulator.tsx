'use client';

import { Banner, Button, Chip, NumberInput, Panel, Select } from '@kora/ui';
import { useRef, useState } from 'react';

import { SimApiError, simApi } from '@/lib/sim/client';
import { buildCsv } from '@/lib/sim/csv';
import { fmtPct } from '@/lib/sim/format';
import type { PaperProjection, ProjectRequest, Scenario, SizingModel } from '@/lib/sim/types';
import { retailLossSentence } from '@/lib/retail-loss';

import { DrawdownHistogram } from './DrawdownHistogram';
import { downloadCsv, downloadSvgAsPng } from './export';
import { FanChart } from './FanChart';
import { CompareTable, KpiTiles, PaperCard, RealityChecks, RiskTable } from './ResultPanels';
import { Slider } from './Slider';

interface Form {
  startingCapital: string;
  sizingModel: SizingModel;
  riskPct: number;
  fixedAmount: string;
  kellyFraction: number;
  winRatePct: number;
  avgWinR: number;
  costPerTradeR: number;
  tradesPerPeriod: number;
  horizonPeriods: number;
  ruinFloorPct: number;
  withdrawal: string;
  stressOn: boolean;
  stressCutPct: number;
  fatOn: boolean;
  fatProbPct: number;
  fatMultiple: number;
  paths: number;
  seed: string;
}

/** Prototype defaults (Simulator.png). Costs are on by default. */
const DEFAULTS: Form = {
  startingCapital: '10000',
  sizingModel: 'fixed_fractional',
  riskPct: 1,
  fixedAmount: '100',
  kellyFraction: 0.5,
  winRatePct: 45,
  avgWinR: 1.8,
  costPerTradeR: 0.08,
  tradesPerPeriod: 20,
  horizonPeriods: 24,
  ruinFloorPct: 50,
  withdrawal: '0',
  stressOn: false,
  stressCutPct: 50,
  fatOn: true,
  fatProbPct: 3,
  fatMultiple: 3,
  paths: 10_000,
  seed: '1',
};

const num = (s: string, fallback: number) => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : fallback;
};

function toRequest(f: Form): ProjectRequest {
  return {
    startingCapital: num(f.startingCapital, 0),
    sizingModel: f.sizingModel,
    riskPct: f.riskPct,
    fixedAmount: num(f.fixedAmount, 0),
    kellyFraction: f.kellyFraction,
    winRatePct: f.winRatePct,
    avgWinR: f.avgWinR,
    costPerTradeR: f.costPerTradeR,
    tradesPerPeriod: f.tradesPerPeriod,
    horizonPeriods: f.horizonPeriods,
    ruinFloorPct: f.ruinFloorPct,
    fatTailProbPct: f.fatOn ? f.fatProbPct : 0,
    fatTailMultiple: f.fatMultiple,
    stressEdgeCutPct: f.stressOn ? f.stressCutPct : 0,
    withdrawals: { perPeriod: num(f.withdrawal, 0), oneOff: [] },
    seed: Math.trunc(num(f.seed, 1)),
    paths: f.paths,
  };
}

const SIZING_NOTE: Record<SizingModel, string> = {
  fixed_fractional:
    'Sizing: fixed-fractional (risk % of current equity per trade). Every trade pays the cost in R, win or lose.',
  fixed_amount:
    'Sizing: fixed amount (the same currency risk on every trade, whatever the balance). Every trade pays the cost in R.',
  kelly_fraction:
    'Sizing: a fraction of full Kelly, computed after costs and fat tails. Every trade pays the cost in R.',
};

export function GainSimulator({ retailLossPct }: { retailLossPct?: string | null } = {}) {
  const [form, setForm] = useState<Form>(DEFAULTS);
  const [current, setCurrent] = useState<Scenario | null>(null);
  const [pinned, setPinned] = useState<Scenario | null>(null);
  const [paper, setPaper] = useState<PaperProjection | null>(null);
  const [busy, setBusy] = useState<null | 'project' | 'paper' | 'backtest'>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chartRef = useRef<SVGSVGElement>(null);

  const label = () => (pinned ? 'B' : 'Current');

  async function project(f: Form = form) {
    setBusy('project');
    setError(null);
    setNote(null);
    try {
      const request = toRequest(f);
      const result = await simApi.project(request);
      setCurrent({ label: label(), origin: 'assumptions', request, result });
      setPaper(null);
      setStale(false);
    } catch (e) {
      setError(
        e instanceof SimApiError ? e.message : 'The projection failed. Nothing was simulated.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function importPaper() {
    setBusy('paper');
    setError(null);
    setNote(null);
    try {
      const r = toRequest(form);
      const res = await simApi.paperProject({
        tradesPerPeriod: r.tradesPerPeriod,
        horizonPeriods: r.horizonPeriods,
        ruinFloorPct: r.ruinFloorPct,
        seed: r.seed,
        paths: r.paths,
      });
      setPaper(res);
      setCurrent({ label: label(), origin: 'paper', request: r, result: res.projection });
      setStale(false);
    } catch (e) {
      setError(e instanceof SimApiError ? e.message : 'The paper import failed.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Import from backtest (goal 06, B-502): the out-of-sample R multiples of the chosen (or latest)
   * robot backtest are block-bootstrapped at the current risk per trade.
   */
  async function importBacktest() {
    setBusy('backtest');
    setError(null);
    setNote(null);
    try {
      const wanted = new URLSearchParams(window.location.search).get('backtest');
      let runId = wanted;
      if (!runId) {
        const list = await fetch('/api/backtests?kind=backtest&limit=1', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (list.status === 403) {
          setNote(
            'Backtests come from the robot builder, which needs a trader, quant or admin account.',
          );
          return;
        }
        const runs = ((await list.json()) as { runs?: Array<{ id: string }> }).runs ?? [];
        runId = runs[0]?.id ?? null;
      }
      if (!runId) {
        setNote(
          'No backtest yet: build a robot and run a backtest first, then import its out-of-sample trades here.',
        );
        return;
      }
      const tr = await fetch(`/api/backtests/${runId}/trades?segment=oos`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!tr.ok)
        throw new SimApiError(tr.status, 'import_failed', 'That backtest could not be loaded.');
      const body = (await tr.json()) as { trades: number[]; source: string };
      if (body.trades.length < 2) {
        setNote('That backtest has fewer than two out-of-sample trades: too few to project.');
        return;
      }
      const r = toRequest(form);
      const result = await simApi.fromTrades({
        trades: body.trades,
        tradeUnit: 'r_multiple',
        source: body.source,
        riskPct: r.riskPct,
        startingCapital: r.startingCapital,
        tradesPerPeriod: r.tradesPerPeriod,
        horizonPeriods: r.horizonPeriods,
        ruinFloorPct: r.ruinFloorPct,
        seed: r.seed,
        paths: r.paths,
      });
      setCurrent({ label: label(), origin: 'backtest', request: r, result });
      setPaper(null);
      setStale(false);
      setNote(
        `Imported ${body.trades.length} out-of-sample backtest trades (R multiples), block-bootstrapped at ${r.riskPct.toFixed(2)}% risk per trade.`,
      );
    } catch (e) {
      setError(e instanceof SimApiError ? e.message : 'The backtest import failed.');
    } finally {
      setBusy(null);
    }
  }

  /** Slider edits mark the result stale; runs are explicit (and audited). */
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (current) setStale(true);
  };

  /** Toggles are explicit actions: they re-run straight away. */
  const toggle = (key: 'stressOn' | 'fatOn', value: boolean) => {
    const next = { ...form, [key]: value };
    setForm(next);
    void project(next);
  };

  const pin = () => {
    if (!current) return;
    setPinned({ ...current, label: 'A' });
    setCurrent({ ...current, label: 'B' });
    setNote(
      'Pinned as scenario A. Change the assumptions (or import the paper account) and run again to compare.',
    );
  };

  const comparing =
    pinned !== null && current !== null && pinned.result.inputHash !== current.result.inputHash;
  const scenarios = comparing ? [pinned, current] : current ? [current] : [];
  const exportCsv = () =>
    downloadCsv(
      buildCsv(scenarios),
      `kora-simulation-${current?.result.inputHash.slice(0, 8) ?? 'run'}.csv`,
    );
  const exportPng = async () => {
    if (!chartRef.current) return;
    try {
      await downloadSvgAsPng(
        chartRef.current,
        `kora-simulation-${current?.result.inputHash.slice(0, 8) ?? 'run'}.png`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const r = current?.result;
  const origin =
    current?.origin === 'paper'
      ? `Paper results · block bootstrap (${r?.effective.blockSize ?? '—'}-trade blocks)`
      : current?.origin === 'backtest'
        ? `Backtest out-of-sample trades · block bootstrap (${r?.effective.blockSize ?? '—'}-trade blocks)`
        : 'Equity projection · percentile fan';

  return (
    <div className="flex flex-col gap-2 xl:h-full xl:min-h-0">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <h1 className="m-0 text-lg font-semibold">Gain Simulator</h1>
        <p className="m-0 text-sm text-muted">
          Monte Carlo projection of a trading edge ·{' '}
          <span className="k-num">{form.paths.toLocaleString('en-US')}</span> paths · costs included
        </p>
        <Chip tone="warn" data-testid="simulated-chip">
          SIMULATED
        </Chip>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={pin} disabled={!current || busy !== null} data-testid="pin-a">
            {pinned ? 'Re-pin current as A' : 'Pin as scenario A'}
          </Button>
          {pinned ? (
            <Button size="sm" variant="ghost" onClick={() => setPinned(null)} data-testid="clear-a">
              Clear A
            </Button>
          ) : null}
          <Button size="sm" onClick={exportCsv} disabled={!current} data-testid="export-csv">
            Export CSV
          </Button>
          <Button
            size="sm"
            onClick={() => void exportPng()}
            disabled={!current}
            data-testid="export-png"
          >
            Export PNG
          </Button>
        </div>
      </header>

      <div className="grid gap-2 xl:grid-cols-[300px_minmax(0,1fr)_320px] xl:flex-1 xl:min-h-0">
        {/* Assumptions */}
        <Panel
          title="Assumptions"
          actions={
            <Button
              size="sm"
              onClick={() => void importBacktest()}
              disabled={busy !== null}
              data-testid="import-backtest"
            >
              {busy === 'backtest' ? 'Importing…' : 'Import from backtest'}
            </Button>
          }
          className="xl:flex xl:flex-col xl:min-h-0"
          bodyClassName="flex flex-col gap-4 xl:overflow-y-auto xl:min-h-0 xl:flex-1"
        >
          <NumberInput
            label="Starting capital (USD)"
            value={form.startingCapital}
            onValueChange={(v) => set('startingCapital', v)}
            precision={0}
            min="1"
            data-testid="starting-capital"
          />
          <Select
            label="Sizing model"
            value={form.sizingModel}
            onChange={(e) => set('sizingModel', e.target.value as SizingModel)}
            options={[
              { value: 'fixed_fractional', label: 'Fixed-fractional (risk %)' },
              { value: 'fixed_amount', label: 'Fixed amount' },
              { value: 'kelly_fraction', label: 'Kelly fraction' },
            ]}
            data-testid="sizing-model"
          />
          {form.sizingModel === 'fixed_fractional' ? (
            <Slider
              label="Risk per trade"
              value={form.riskPct}
              min={0.1}
              max={5}
              step={0.05}
              onChange={(v) => set('riskPct', v)}
              display={(v) => `${v.toFixed(2)}%`}
              hint="Share of equity lost if the stop is hit"
              testId="risk-pct"
            />
          ) : form.sizingModel === 'fixed_amount' ? (
            <NumberInput
              label="Risk per trade (USD)"
              value={form.fixedAmount}
              onValueChange={(v) => set('fixedAmount', v)}
              precision={0}
              min="1"
              hint="Lost if the stop is hit, on every trade"
            />
          ) : (
            <Slider
              label="Kelly fraction"
              value={form.kellyFraction}
              min={0.05}
              max={1}
              step={0.05}
              onChange={(v) => set('kellyFraction', v)}
              display={(v) => `${v.toFixed(2)}× Kelly`}
              hint="Most professionals use ¼ to ½ Kelly"
            />
          )}
          <Slider
            label="Win rate"
            value={form.winRatePct}
            min={1}
            max={99}
            step={1}
            onChange={(v) => set('winRatePct', v)}
            display={(v) => `${v}%`}
            hint="Use out-of-sample results, not in-sample"
            testId="win-rate"
          />
          <Slider
            label="Avg win / avg loss"
            value={form.avgWinR}
            min={0.2}
            max={5}
            step={0.1}
            onChange={(v) => set('avgWinR', v)}
            display={(v) => `${v.toFixed(1)} R`}
            hint="Reward in multiples of the risk"
            testId="avg-win"
          />
          <Slider
            label="Costs per trade"
            value={form.costPerTradeR}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => set('costPerTradeR', v)}
            display={(v) => `${v.toFixed(2)} R`}
            hint="Spread + fees + slippage + swap"
            testId="costs"
          />
          <Slider
            label="Trades per month"
            value={form.tradesPerPeriod}
            min={1}
            max={100}
            step={1}
            onChange={(v) => set('tradesPerPeriod', v)}
            display={(v) => String(v)}
            hint="Frequency multiplies both edge and costs"
            testId="trades-per-month"
          />
          <Slider
            label="Horizon"
            value={form.horizonPeriods}
            min={1}
            max={60}
            step={1}
            onChange={(v) => set('horizonPeriods', v)}
            display={(v) => `${v} months`}
            testId="horizon"
          />
          <Slider
            label="Ruin floor"
            value={form.ruinFloorPct}
            min={0}
            max={90}
            step={5}
            onChange={(v) => set('ruinFloorPct', v)}
            display={(v) => `${v}% of start`}
            hint="Level at which you would stop trading"
            testId="ruin-floor"
          />
          <NumberInput
            label="Withdrawal per month (USD)"
            value={form.withdrawal}
            onValueChange={(v) => set('withdrawal', v)}
            precision={0}
            min="0"
          />
          <div className="grid grid-cols-2 gap-2">
            <Select
              label="Paths"
              value={String(form.paths)}
              onChange={(e) => set('paths', Number(e.target.value))}
              options={[
                { value: '1000', label: '1,000' },
                { value: '10000', label: '10,000' },
                { value: '50000', label: '50,000' },
              ]}
            />
            <NumberInput
              label="Seed"
              value={form.seed}
              onValueChange={(v) => set('seed', v)}
              precision={0}
              min="0"
            />
          </div>
          <hr className="w-full border-0 border-t border-border m-0" />
          <fieldset className="border-0 m-0 p-0 flex flex-col gap-3">
            <legend className="k-sr-only">Stress and fat tails</legend>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[var(--k-warn)]"
                checked={form.stressOn}
                onChange={(e) => toggle('stressOn', e.target.checked)}
                data-testid="toggle-stress"
              />
              Stress test: cut the edge by {form.stressCutPct}%
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[var(--k-warn)]"
                checked={form.fatOn}
                onChange={(e) => toggle('fatOn', e.target.checked)}
                data-testid="toggle-fat-tails"
              />
              Fat tails: {form.fatProbPct}% of losses gap to {form.fatMultiple}R
            </label>
          </fieldset>
          <p className="m-0 p-3 text-xs text-muted border border-border rounded">
            {SIZING_NOTE[form.sizingModel]}
          </p>
          <Button
            variant="primary"
            block
            onClick={() => void project()}
            disabled={busy !== null}
            data-testid="run-projection"
          >
            {busy === 'project' ? 'Simulating…' : current ? 'Run again' : 'Run projection'}
          </Button>
          <Button
            block
            onClick={() => void importPaper()}
            disabled={busy !== null}
            data-testid="import-paper"
          >
            {busy === 'paper' ? 'Importing…' : 'Project from my paper results'}
          </Button>
          {stale ? (
            <p className="m-0 text-xs text-warn" role="status" data-testid="stale-note">
              Assumptions changed. Run again to update the projection.
            </p>
          ) : null}
        </Panel>

        {/* Chart + KPIs */}
        <div
          className="flex flex-col gap-2 min-w-0 xl:min-h-0 xl:overflow-y-auto"
          role="region"
          aria-label="Projection results"
          tabIndex={0}
        >
          <Panel
            title={origin}
            actions={
              <ul
                className="hidden md:flex flex-wrap justify-end gap-x-3 list-none m-0 p-0 text-[11px] text-muted whitespace-nowrap"
                aria-label="Chart legend"
              >
                <li>
                  <span aria-hidden="true" className="text-accent">
                    ■
                  </span>{' '}
                  P5–P95
                </li>
                <li>
                  <span aria-hidden="true" className="text-accent opacity-80">
                    ■
                  </span>{' '}
                  P25–P75
                </li>
                <li>
                  <span aria-hidden="true">—</span> Median
                </li>
                <li>
                  <span aria-hidden="true" className="text-down">
                    - -
                  </span>{' '}
                  Ruin floor
                </li>
                <li>
                  <span aria-hidden="true">- -</span> Start
                </li>
                {comparing ? (
                  <li>
                    <span aria-hidden="true" className="text-warn">
                      - -
                    </span>{' '}
                    Scenario A
                  </li>
                ) : null}
              </ul>
            }
            className="shrink-0"
          >
            {error ? (
              <Banner tone="critical" title="Nothing was simulated.">
                <span data-testid="sim-error">{error}</span>
              </Banner>
            ) : null}
            {note ? (
              <p className="mt-0 text-xs text-muted" role="status" data-testid="sim-note">
                {note}
              </p>
            ) : null}
            {r ? (
              <>
                <p className="mt-0 mb-2 text-xs text-ai">
                  Violet: 3 sample paths, to show how bumpy a single account really is.
                </p>
                <FanChart
                  ref={chartRef}
                  result={r}
                  compare={comparing ? { label: 'A', result: pinned.result } : null}
                  title={origin}
                />
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-muted">
                    Chart data (percentiles per month)
                  </summary>
                  <div className="max-h-56 overflow-auto mt-2">
                    <table className="w-full k-num text-right">
                      <thead>
                        <tr className="text-muted">
                          <th scope="col" className="text-left">
                            Month
                          </th>
                          <th scope="col">P5</th>
                          <th scope="col">P25</th>
                          <th scope="col">Median</th>
                          <th scope="col">P75</th>
                          <th scope="col">P95</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.bands.p50.map((_, i) => (
                          <tr key={i}>
                            <th scope="row" className="text-left font-normal">
                              M{i}
                            </th>
                            <td>{Math.round(r.bands.p5[i]!)}</td>
                            <td>{Math.round(r.bands.p25[i]!)}</td>
                            <td>{Math.round(r.bands.p50[i]!)}</td>
                            <td>{Math.round(r.bands.p75[i]!)}</td>
                            <td>{Math.round(r.bands.p95[i]!)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              <div
                className="flex flex-col items-center justify-center text-center min-h-80 gap-2"
                data-testid="sim-empty"
              >
                <p className="m-0 text-lg">Set your assumptions and run the projection.</p>
                <p className="m-0 text-sm text-muted max-w-md">
                  Every projection is a distribution of outcomes with costs included, never a single
                  line. Or project from your paper account results.
                </p>
              </div>
            )}
          </Panel>
          {r ? <KpiTiles result={r} /> : null}
          {comparing ? (
            <Panel>
              <CompareTable a={pinned} b={current} />
            </Panel>
          ) : null}
        </div>

        {/* Right column */}
        <div
          className="flex flex-col gap-2 min-w-0 xl:min-h-0 xl:overflow-y-auto"
          role="region"
          aria-label="Risk and reality checks"
          tabIndex={0}
        >
          {paper ? (
            <PaperCard
              analytics={paper.analytics}
              source={paper.source}
              onClose={() => void project()}
            />
          ) : null}
          <Panel
            title="Max drawdown distribution"
            actions={
              r ? (
                <span className="k-num text-xs text-muted">
                  median {fmtPct(r.maxDrawdown.median)} · P95 {fmtPct(r.maxDrawdown.p95)}
                </span>
              ) : null
            }
          >
            {r ? (
              <DrawdownHistogram result={r} />
            ) : (
              <p className="m-0 text-sm text-muted">Appears after a run.</p>
            )}
          </Panel>
          <Panel title="Risk">
            {r ? (
              <RiskTable result={r} />
            ) : (
              <p className="m-0 text-sm text-muted">Appears after a run.</p>
            )}
          </Panel>
          <Panel title="Reality checks" className="flex-1">
            {r ? (
              <RealityChecks checks={r.realityChecks} />
            ) : (
              <p className="m-0 text-sm text-muted">Checks run with every projection.</p>
            )}
            <p className="mb-0 mt-4 text-[11px] text-muted" data-testid="sim-disclaimer">
              Projections assume your edge stays constant, which real markets rarely allow.{' '}
              {retailLossSentence(retailLossPct)} Not investment advice.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
