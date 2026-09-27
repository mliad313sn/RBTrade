'use client';

import { KILL_SWITCH_HOLD_MS, resolveNum, type StrategyDefinition } from '@kora/domain';
import { Banner, Button, Chip, HoldToConfirmButton, Panel, Select, useToast } from '@kora/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { refreshAccount } from '@/lib/account';
import { api } from '@/lib/api-browser';
import { RobotsApiError, robotsApi } from '@/lib/robots/client';
import { fmtNum, fmtSigned, pauseLabel } from '@/lib/robots/format';
import type {
  AuditItem,
  BacktestResult,
  ChecklistView,
  RobotDetail,
  RobotSummary,
  SensitivityResult,
  SimProjection,
  StrategyDetail,
  StrategySummary,
  WalkForwardResult,
} from '@/lib/robots/types';

import { RobotCopilot } from '../ai/RobotCopilot';

import { BlockChips } from './BlockChips';
import { EquityChart } from './EquityChart';
import { Heatmap } from './Heatmap';
import { KpiTable } from './KpiTable';
import { AuditFeed, PromotionChecklist, RiskMeters } from './MonitorParts';

type Busy = null | 'backtest' | 'wf' | 'heatmap' | 'mc' | 'run' | 'pause' | 'switch';

interface SignalView {
  id: string;
  action: string;
  symbol: string;
  barTs: string;
  conditions: Array<{
    label: string;
    result: boolean | 'not_available';
    contribution: number | null;
    skipped?: boolean;
  }>;
}

/** Around the current value: 5 values on the parameter's step (or ±40 %), inside its min/max. */
function axis(def: StrategyDefinition, name: string): number[] {
  const p = def.params[name]!;
  const step = p.step ?? (p.integer ? Math.max(1, Math.round(p.value * 0.2)) : p.value * 0.2);
  const out: number[] = [];
  for (let k = -2; k <= 2; k++) {
    let v = p.value + k * step;
    v = p.integer ? Math.round(v) : Math.round(v * 1e6) / 1e6;
    if (
      (p.min === undefined || v >= p.min) &&
      (p.max === undefined || v <= p.max) &&
      v > 0 &&
      !out.includes(v)
    )
      out.push(v);
  }
  return out.length >= 2 ? out : [p.value, p.value * 1.5];
}

const STATUS_TONE: Record<string, string> = {
  running: 'var(--k-up)',
  paused: 'var(--k-text-muted)',
  draft: 'var(--k-text-muted)',
  stopped: 'var(--k-kill)',
};

export function RobotsMonitor() {
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const [robots, setRobots] = useState<RobotSummary[]>([]);
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [strategy, setStrategy] = useState<StrategyDetail | null>(null);
  const [robot, setRobot] = useState<RobotDetail | null>(null);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [promotion, setPromotion] = useState<ChecklistView | null>(null);
  const [signal, setSignal] = useState<SignalView | null>(null);
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [wf, setWf] = useState<WalkForwardResult | null>(null);
  const [heat, setHeat] = useState<SensitivityResult | null>(null);
  const [mc, setMc] = useState<SimProjection | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [trials, setTrials] = useState<number | null>(null);
  const [hx, setHx] = useState('');
  const [hy, setHy] = useState('');

  const robotId = search.get('robot');
  const strategyParam = search.get('strategy');
  const strategyId =
    robot?.strategyId ?? strategyParam ?? robots.find((r) => r.id === robotId)?.strategyId ?? null;

  const loadLists = useCallback(async () => {
    const [r, s] = await Promise.all([robotsApi.robots(), robotsApi.strategies()]);
    setRobots(r.robots);
    setStrategies(s.strategies);
    return { r: r.robots, s: s.strategies };
  }, []);

  // Default selection: first robot, else first strategy.
  useEffect(() => {
    void loadLists()
      .then(({ r, s }) => {
        if (!robotId && !strategyParam) {
          if (r[0]) router.replace(`/robots?robot=${r[0].id}`);
          else if (s[0]) router.replace(`/robots?strategy=${s[0].id}`);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [loadLists, robotId, strategyParam, router]);

  const loadRobot = useCallback(async () => {
    if (!robotId) {
      setRobot(null);
      setPromotion(null);
      return;
    }
    const [d, a, p, s] = await Promise.all([
      robotsApi.robot(robotId),
      robotsApi.robotAudit(robotId),
      robotsApi.promotion(robotId),
      fetch(`/api/robots/${robotId}/signals?limit=50`, {
        credentials: 'include',
        cache: 'no-store',
      }).then((x) => x.json() as Promise<{ signals: SignalView[] }>),
    ]);
    setRobot(d);
    setAudit(a.events);
    setPromotion(p);
    setSignal(s.signals.find((x) => x.action !== 'hold') ?? s.signals[0] ?? null);
  }, [robotId]);

  useEffect(() => {
    void loadRobot().catch((e: Error) => setError(e.message));
    if (!robotId) return;
    const t = setInterval(() => void loadRobot().catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, [loadRobot, robotId]);

  const version = useMemo(() => {
    if (!strategy) return null;
    if (robot)
      return strategy.versions.find((v) => v.id === robot.versionId) ?? strategy.versions[0]!;
    return strategy.versions[0]!;
  }, [strategy, robot]);

  const loadStrategy = useCallback(async () => {
    if (!strategyId) return;
    const s = await robotsApi.strategy(strategyId);
    setStrategy(s);
    setTrials(s.trials);
    if (!robotId) setAudit((await robotsApi.strategyAudit(strategyId)).events);
  }, [strategyId, robotId]);

  useEffect(() => {
    void loadStrategy().catch((e: Error) => setError(e.message));
  }, [loadStrategy]);

  // Latest stored runs for the version on screen.
  useEffect(() => {
    if (!strategy || !version) return;
    setBt(null);
    setWf(null);
    setHeat(null);
    setMc(null);
    const names = Object.keys(version.definition.params);
    setHx(names[0] ?? '');
    setHy(names[1] ?? names[0] ?? '');
    void robotsApi.runs(strategy.id).then(async ({ runs }) => {
      const mine = runs.filter((r) => r.versionId === version.id);
      const get = async (kind: string) => {
        const r = mine.find((x) => x.kind === kind);
        return r ? ((await robotsApi.run(r.id)).result as Record<string, unknown>) : null;
      };
      const [b, w, h] = await Promise.all([
        get('backtest'),
        get('walk_forward'),
        get('sensitivity'),
      ]);
      const id = (kind: string) => mine.find((x) => x.kind === kind)?.id ?? '';
      if (b) setBt({ ...(b as unknown as BacktestResult), runId: id('backtest') });
      if (w) setWf({ ...(w as unknown as WalkForwardResult), runId: id('walk_forward') });
      if (h) setHeat({ ...(h as unknown as SensitivityResult), runId: id('sensitivity') });
    });
  }, [strategy, version]);

  const act = async (b: Busy, fn: () => Promise<void>) => {
    setBusy(b);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof RobotsApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const def = version?.definition;
  const riskPct = def?.size.kind === 'risk_pct' ? resolveNum(def.size.pct, def.params) : 1;
  const oosTrades = bt?.trades.filter((t) => t.segment === 'oos') ?? [];
  const latest = strategy?.versions[0];

  const runBacktest = () =>
    act('backtest', async () => {
      const r = await robotsApi.backtest(version!.id);
      setBt(r);
      setTrials(r.trialsTotal);
    });
  const runWalkForward = () =>
    act('wf', async () => {
      const r = await robotsApi.walkForward(version!.id);
      setWf(r);
      setTrials(r.trialsTotal);
    });
  const runHeatmap = () =>
    act('heatmap', async () => {
      if (!hx || !hy || hx === hy)
        throw new Error('Pick two different parameters for the heatmap.');
      const r = await robotsApi.sensitivity(
        version!.id,
        { param: hx, values: axis(def!, hx) },
        { param: hy, values: axis(def!, hy) },
      );
      setHeat(r);
      setTrials(r.trialsTotal);
    });
  const sendToMonteCarlo = () =>
    act('mc', async () => {
      if (!bt) throw new Error('Run a backtest first.');
      if (oosTrades.length < 2)
        throw new Error(
          'At least two out-of-sample trades are needed for a Monte Carlo projection.',
        );
      setMc(
        await robotsApi.monteCarlo(
          oosTrades.map((t) => t.rMultiple),
          'backtest_out_of_sample',
          riskPct,
        ),
      );
    });
  const paperRun = () =>
    act('run', async () => {
      let id = robot?.id;
      if (!id) {
        const created = await robotsApi.createRobot(strategy!.name, version!.id);
        id = created.id;
      }
      await robotsApi.start(id);
      await loadLists();
      router.replace(`/robots?robot=${id}`);
      await loadRobot();
    });
  const pause = () =>
    act('pause', async () => {
      await robotsApi.pause(robot!.id, 'Paused from the robot monitor');
      await Promise.all([loadRobot(), loadLists()]);
    });
  const switchVersion = () =>
    act('switch', async () => {
      await robotsApi.switchVersion(
        robot!.id,
        latest!.id,
        `Switch to v${latest!.version} ${latest!.shortHash}`,
      );
      await Promise.all([loadRobot(), loadLists(), loadStrategy()]);
    });

  const haltAll = async () => {
    try {
      const r = await api.killSwitch('robots_cancel_flatten', 'ui_button');
      toast.push(
        `Kill switch: every robot halted, ${r.ordersCancelled} orders cancelled, ${r.positionsFlattened} positions closed. Audit event #${r.auditEventId}.`,
        'success',
        10000,
      );
      refreshAccount();
      await Promise.all([loadLists(), loadRobot()]);
    } catch {
      toast.push(
        'Kill switch request failed. Use the top-bar kill switch or the REST fallback.',
        'critical',
        10000,
      );
    }
  };

  const withoutRobot = strategies.filter((s) => !robots.some((r) => r.strategyId === s.id));

  return (
    <div className="flex flex-col gap-2">
      <h1 className="k-sr-only">Robots</h1>
      {error ? (
        <div data-testid="robots-error">
          <Banner tone="critical">{error}</Banner>
        </div>
      ) : null}
      <div className="grid gap-2 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
        {/* Left: robots, strategies, kill switch */}
        <div className="flex flex-col gap-2">
          <Panel
            title="My robots"
            actions={
              <Link href="/robots/builder" className="k-btn k-btn--sm" data-testid="new-robot">
                + New
              </Link>
            }
          >
            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="robot-list">
              {robots.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/robots?robot=${r.id}`}
                    className="block rounded border p-2 no-underline"
                    style={{
                      borderColor: r.id === robotId ? 'var(--k-accent)' : 'var(--k-border)',
                      color: 'var(--k-text)',
                    }}
                    aria-current={r.id === robotId ? 'true' : undefined}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <strong className="text-sm">{r.name}</strong>
                      <span
                        className="text-xs font-semibold"
                        style={{ color: STATUS_TONE[r.status] }}
                        data-testid={`robot-status-${r.id}`}
                      >
                        ● {r.status.toUpperCase()}
                      </span>
                    </span>
                    <span className="block text-xs text-muted">
                      {r.symbols.join(', ')} · {r.timeframe} · PAPER
                      {r.pauseReason ? ` · ${pauseLabel(r.pauseReason)}` : ''}
                    </span>
                    <span
                      className="k-num block text-sm"
                      style={{ color: Number(r.pnl) >= 0 ? 'var(--k-up)' : 'var(--k-down)' }}
                    >
                      {Number(r.pnl) >= 0 ? '▲ ' : '▼ '}
                      {fmtSigned(Number(r.pnl), 2)}
                    </span>
                  </Link>
                </li>
              ))}
              {!robots.length ? <li className="text-sm text-muted">No robots yet.</li> : null}
            </ul>
            {withoutRobot.length ? (
              <>
                <h3 className="mb-1 mt-3 text-xs font-semibold uppercase text-muted">Strategies</h3>
                <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="strategy-list">
                  {withoutRobot.map((s) => (
                    <li key={s.id}>
                      <Link
                        href={`/robots?strategy=${s.id}`}
                        className="block rounded border p-2 text-sm no-underline"
                        style={{
                          borderColor:
                            s.id === strategyParam && !robotId
                              ? 'var(--k-accent)'
                              : 'var(--k-border)',
                          color: 'var(--k-text)',
                        }}
                      >
                        {s.name}{' '}
                        <span className="k-num text-xs text-muted">
                          v{s.latestVersion} {s.latest?.shortHash}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Panel>
          <Panel title="Kill switch" className="border-[var(--k-kill)]">
            <p className="mt-0 text-xs text-muted">
              Halts every robot, cancels all orders, flattens all positions. Hold 1.5 s, or click and confirm.
            </p>
            <HoldToConfirmButton
              holdMs={KILL_SWITCH_HOLD_MS}
              variant="danger"
              className="k-btn--block"
              onConfirm={() => void haltAll()}
              description="Kill switch: robots, orders and positions."
              confirmTitle="Halt every robot, cancel all orders and flatten all positions?"
              data-testid="halt-all"
            >
              ■ HOLD TO HALT ALL
            </HoldToConfirmButton>
          </Panel>
        </div>

        {/* Center */}
        <div className="flex min-w-0 flex-col gap-2">
          {!strategy || !version || !def ? (
            <Panel title="Robot trader">
              <p className="text-sm text-muted">
                Build a strategy from blocks, test it honestly (in-sample, out-of-sample,
                walk-forward) and paper-run it through the same order system as manual trading.
              </p>
              <Link href="/robots/builder" className="k-btn k-btn--primary">
                Open the builder
              </Link>
            </Panel>
          ) : (
            <>
              <Panel
                title={
                  <span className="flex flex-wrap items-baseline gap-2 normal-case tracking-normal">
                    <span
                      className="text-base font-semibold"
                      style={{ color: 'var(--k-text)' }}
                      data-testid="strategy-name"
                    >
                      {strategy.name}
                    </span>
                    <span className="k-num text-xs" data-testid="version-hash">
                      v{version.version} · params {version.shortHash}
                    </span>
                    <span className="text-xs">
                      {def.universe.symbols.join(', ')} · {def.universe.timeframe}
                    </span>
                    <Chip tone="paper">PAPER</Chip>
                    <Chip tone="warn">SIMULATED</Chip>
                  </span>
                }
                actions={
                  <span className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      onClick={() => void runBacktest()}
                      disabled={busy !== null}
                      data-testid="run-backtest"
                    >
                      {busy === 'backtest' ? 'Backtesting…' : 'Backtest'}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void runWalkForward()}
                      disabled={busy !== null}
                      data-testid="run-wf"
                    >
                      {busy === 'wf' ? 'Running…' : 'Run walk-forward'}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void sendToMonteCarlo()}
                      disabled={busy !== null || !bt}
                      data-testid="send-mc"
                    >
                      {busy === 'mc' ? 'Projecting…' : 'Send to Monte Carlo ▸'}
                    </Button>
                    <Link
                      href={`/robots/builder?strategy=${strategy.id}`}
                      className="k-btn k-btn--sm"
                      data-testid="edit-builder"
                    >
                      Edit in builder
                    </Link>
                    {robot?.status === 'running' ? (
                      <Button
                        size="sm"
                        onClick={() => void pause()}
                        disabled={busy !== null}
                        data-testid="pause-robot"
                      >
                        Pause
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void paperRun()}
                        disabled={busy !== null}
                        data-testid="paper-run"
                      >
                        {robot ? 'Run (paper)' : 'Paper-run'}
                      </Button>
                    )}
                  </span>
                }
              >
                <BlockChips definition={def} />
                {robot && latest && latest.id !== robot.versionId ? (
                  <div
                    className="mt-2 flex flex-wrap items-center gap-2 text-sm"
                    data-testid="new-version-banner"
                  >
                    <span>
                      This robot runs v{robot.version} ({robot.shortHash}); v{latest.version} (
                      {latest.shortHash}) is the latest.
                    </span>
                    {robot.status !== 'running' ? (
                      <Button
                        size="sm"
                        onClick={() => void switchVersion()}
                        disabled={busy !== null}
                        data-testid="switch-version"
                      >
                        Switch robot to v{latest.version}
                      </Button>
                    ) : (
                      <span className="text-muted">Pause the robot to switch.</span>
                    )}
                  </div>
                ) : null}
                {robot ? (
                  <p className="mb-0 mt-2 text-xs text-muted" data-testid="robot-state">
                    Robot {robot.name}:{' '}
                    <strong style={{ color: STATUS_TONE[robot.status] }}>
                      {robot.status.toUpperCase()}
                    </strong>
                    {robot.pauseReason ? ` · ${pauseLabel(robot.pauseReason)}` : ''} · equity{' '}
                    <span className="k-num">
                      {Number(robot.book.equity).toLocaleString('en-US', {
                        maximumFractionDigits: 2,
                      })}
                    </span>{' '}
                    {robot.baseCurrency}
                    {robot.accountHalted ? ' · account halted by the kill switch' : ''}
                  </p>
                ) : null}
              </Panel>

              <Panel
                title="Backtest · equity (net of costs)"
                actions={
                  <span className="text-xs text-muted">
                    — In-sample · - - Out-of-sample · ▒ Drawdown
                  </span>
                }
              >
                {bt ? (
                  <EquityChart
                    t={bt.equity.t}
                    equity={bt.equity.equity}
                    drawdown={bt.equity.drawdown}
                    oosStart={bt.oosStart}
                    currency={bt.baseCurrency ?? 'USD'}
                  />
                ) : (
                  <p className="text-sm text-muted">No backtest for this version yet.</p>
                )}
                {bt?.warnings.length ? (
                  <ul
                    className="mb-0 mt-2 flex list-none flex-col gap-1 p-0 text-xs"
                    data-testid="bt-warnings"
                  >
                    {bt.warnings.map((w) => (
                      <li key={w.code} style={{ color: 'var(--k-warn)' }}>
                        ⚠ {w.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Panel>

              <div className="grid gap-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                <Panel title="Metrics">
                  <KpiTable
                    columns={[
                      {
                        label: 'In-sample',
                        m: bt?.metrics.inSample ?? robot?.kpis.inSample ?? null,
                      },
                      {
                        label: 'Out-of-sample',
                        m: bt?.metrics.outOfSample ?? robot?.kpis.outOfSample ?? null,
                        tone: 'var(--k-down)',
                      },
                      { label: 'Walk-fwd', m: wf?.metrics ?? robot?.kpis.walkForward ?? null },
                      { label: `Live (${robot?.kpis.live.days ?? 0}d)`, m: null },
                    ]}
                  />
                  {robot ? (
                    <p className="mb-0 mt-2 text-xs text-muted" data-testid="live-kpis">
                      Live (paper): P&amp;L{' '}
                      <span className="k-num">{fmtSigned(Number(robot.kpis.live.pnl))}</span>{' '}
                      {robot.baseCurrency} ({fmtSigned(Number(robot.kpis.live.returnPct))}%),{' '}
                      {robot.kpis.live.fills} fills, tracking error (30 d){' '}
                      <span className="k-num">
                        {robot.kpis.live.trackingError30dPct === null
                          ? '—'
                          : `${fmtNum(robot.kpis.live.trackingError30dPct)}%`}
                      </span>
                      . Live ratios appear once enough days are tracked.
                    </p>
                  ) : null}
                </Panel>
                <Panel title="Overfitting checks">
                  <dl
                    className="m-0 grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 text-sm"
                    data-testid="overfitting"
                  >
                    <dt className="text-muted">Combos tried</dt>
                    <dd className="k-num m-0 text-right" data-testid="trials">
                      {trials ?? strategy.trials}
                    </dd>
                    <dt className="text-muted">Deflated Sharpe</dt>
                    <dd className="k-num m-0 text-right" data-testid="dsr">
                      {fmtNum(bt?.overfitting.dsr ?? null)}
                    </dd>
                    <dt className="text-muted">Trades (OOS)</dt>
                    <dd className="k-num m-0 text-right">
                      {bt
                        ? `${bt.metrics.outOfSample.trades} ${bt.metrics.outOfSample.trades >= 100 ? '✓' : '⚠ < 100'}`
                        : '—'}
                    </dd>
                  </dl>
                  <h3 className="mb-1 mt-3 text-xs font-semibold uppercase text-muted">
                    Sensitivity · Sharpe (OOS)
                  </h3>
                  <div className="mb-2 flex flex-wrap items-end gap-2">
                    <Select
                      label="Rows"
                      value={hy}
                      onChange={(e) => setHy(e.target.value)}
                      options={Object.keys(def.params).map((p) => ({
                        value: p,
                        label: def.params[p]!.label ?? p,
                      }))}
                      data-testid="heat-y"
                    />
                    <Select
                      label="Columns"
                      value={hx}
                      onChange={(e) => setHx(e.target.value)}
                      options={Object.keys(def.params).map((p) => ({
                        value: p,
                        label: def.params[p]!.label ?? p,
                      }))}
                      data-testid="heat-x"
                    />
                    <Button
                      size="sm"
                      onClick={() => void runHeatmap()}
                      disabled={busy !== null || Object.keys(def.params).length < 2}
                      data-testid="run-heatmap"
                    >
                      {busy === 'heatmap' ? 'Running…' : 'Run heatmap'}
                    </Button>
                  </div>
                  {heat ? (
                    <Heatmap data={heat} />
                  ) : (
                    <p className="text-xs text-muted">Pick two parameters and run the heatmap.</p>
                  )}
                </Panel>
              </div>

              {wf ? (
                <Panel title="Walk-forward folds (out-of-sample windows)">
                  <table className="w-full text-xs" data-testid="wf-folds">
                    <thead>
                      <tr className="text-left text-muted">
                        <th scope="col">Fold</th>
                        <th scope="col">Test window</th>
                        <th scope="col" className="text-right">
                          OOS Sharpe
                        </th>
                        <th scope="col" className="text-right">
                          Trades
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {wf.folds.map((f) => (
                        <tr key={f.fold}>
                          <td>{f.fold}</td>
                          <td className="k-num">
                            {new Date(f.testStart).toISOString().slice(0, 10)} →{' '}
                            {new Date(f.testEnd).toISOString().slice(0, 10)}
                          </td>
                          <td className="k-num text-right">{fmtNum(f.oosSharpe)}</td>
                          <td className="k-num text-right">{f.oosTrades}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              ) : null}

              <Panel
                title="Live monitor · audit log (immutable)"
                actions={
                  robot ? (
                    <span className="text-xs text-muted" data-testid="heartbeat">
                      Heartbeat{' '}
                      {robot.lastHeartbeatAt
                        ? `● ${Math.max(0, (Date.now() - Date.parse(robot.lastHeartbeatAt)) / 1000).toFixed(1)} s`
                        : '— (not running)'}{' '}
                      · every {robot.heartbeatMs / 1000} s
                    </span>
                  ) : null
                }
              >
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                  {robot ? (
                    <RiskMeters usage={robot.limitsUsage} />
                  ) : (
                    <p className="text-sm text-muted">
                      Risk-limit meters appear once the strategy runs as a robot.
                    </p>
                  )}
                  <AuditFeed events={audit} />
                </div>
              </Panel>
            </>
          )}
        </div>

        {/* Right: copilot (goal 07), Monte Carlo, promotion */}
        <div className="flex flex-col gap-2">
          <Panel
            title={<span style={{ color: 'var(--k-ai)' }}>✦ AI copilot</span>}
            actions={<span className="text-xs text-muted">suggests · never executes</span>}
          >
            <RobotCopilot
              robotId={robot?.id ?? null}
              strategyId={strategy?.id ?? null}
              signalId={signal?.id ?? null}
              onVersionSaved={() => void loadStrategy()}
            />
          </Panel>
          {mc ? (
            <Panel title="Monte Carlo (OOS trades)">
              <dl className="m-0 grid grid-cols-[1fr_auto] gap-y-1 text-sm" data-testid="mc-result">
                <dt className="text-muted">Final equity P5 / P50 / P95</dt>
                <dd className="k-num m-0 text-right">
                  {Math.round(mc.finalEquity.p5).toLocaleString('en-US')} /{' '}
                  {Math.round(mc.finalEquity.p50).toLocaleString('en-US')} /{' '}
                  {Math.round(mc.finalEquity.p95).toLocaleString('en-US')}
                </dd>
                <dt className="text-muted">P(end below start)</dt>
                <dd className="k-num m-0 text-right">{(mc.probEndBelowStart * 100).toFixed(1)}%</dd>
              </dl>
              <ul className="mb-2 mt-2 flex list-none flex-col gap-1 p-0 text-xs">
                {mc.realityChecks.map((c) => (
                  <li
                    key={c.code}
                    style={{
                      color: c.severity === 'info' ? 'var(--k-text-muted)' : 'var(--k-warn)',
                    }}
                  >
                    ⚠ {c.title}
                  </li>
                ))}
              </ul>
              <Link
                href={`/simulator?backtest=${bt?.runId ?? ''}`}
                className="k-btn k-btn--sm"
                data-testid="open-simulator"
              >
                Open in the simulator
              </Link>
            </Panel>
          ) : null}
          {robot && promotion ? (
            <Panel title={`Promote ${robot.name} to LIVE · checklist`}>
              <PromotionChecklist
                robotId={robot.id}
                view={promotion}
                onChange={() => void loadRobot()}
              />
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
