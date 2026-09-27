import { createHash } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AUDIT_READ_ALL_ROLES,
  canonicalStrategyJson,
  evidenceEligibility,
  hasAnyRole,
  shortHash,
  withParams,
  type BacktestRequest,
  type OptimiseRequest,
  type Role,
  type SensitivityRequest,
  type WalkForwardRequest,
} from '@kora/domain';
import { strategyContentHash } from '@kora/domain/server';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { AccountsService } from '../trading/accounts.service';
import { ResearchClient } from './research-client';
import { ResearchDataService, type SymbolDataWire } from './research-data.service';
import { StrategiesService, type VersionRow } from './strategies.service';
import { loadIntelConfig } from '../intel/intel-config';

type Kind = 'backtest' | 'walk_forward' | 'optimise' | 'sensitivity';

interface TrialStat {
  params: Record<string, number>;
  isPeriodSharpe: number | null;
  oosPeriodSharpe: number | null;
  isSharpe: number | null;
  oosSharpe: number | null;
  observations: number | null;
}

interface QuantResult {
  trialStats: TrialStat[];
  [key: string]: unknown;
}

/**
 * What a trial was evaluated on (IRTC R3-02): the same parameters on another symbol set, data
 * window (UTC days), split or walk-forward design, or cost override are a different trial.
 */
export interface TrialContext {
  symbols: string[];
  window: [string, string] | null;
  design: Record<string, number | string | null>;
  spreadTicks: number | null;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function trialContext(
  kind: Kind,
  req: BacktestRequest & Partial<Pick<WalkForwardRequest, 'mode' | 'folds' | 'trainFraction'>>,
  data: ReadonlyArray<Pick<SymbolDataWire, 'symbol' | 'bars'>>,
): TrialContext {
  const withBars = data.filter((d) => d.bars.t.length > 0);
  const first = withBars.map((d) => d.bars.t[0]!);
  const last = withBars.map((d) => d.bars.t[d.bars.t.length - 1]!);
  return {
    symbols: data.map((d) => d.symbol).sort(),
    window: withBars.length ? [utcDay(Math.min(...first)), utcDay(Math.max(...last))] : null,
    design:
      kind === 'walk_forward'
        ? {
            walkForward: req.mode ?? 'anchored',
            folds: req.folds ?? null,
            trainFraction: req.trainFraction ?? null,
          }
        : { oosStart: req.split.oosStart ?? null, oosFraction: req.split.oosFraction },
    spreadTicks: req.spreadTicks ?? null,
  };
}

/** Trial identity: the configuration hash and its data context, hashed together. */
export function trialKey(configHash: string, context: TrialContext): string {
  return createHash('sha256')
    .update(canonicalStrategyJson({ config: configHash, context }))
    .digest('hex');
}

interface RunRow {
  id: string;
  strategy_id: string;
  version_id: string;
  user_id: string;
  kind: Kind;
  request: Record<string, unknown>;
  summary: Record<string, unknown>;
  result: Record<string, unknown>;
  trials_added: number;
  gate_eligible?: boolean;
  created_at: Date;
}

const PATHS: Record<Kind, string> = {
  backtest: '/bt/run',
  walk_forward: '/bt/walk-forward',
  optimise: '/bt/optimise',
  sensitivity: '/bt/sensitivity',
};

function runDto(r: RunRow, full: boolean) {
  return {
    id: r.id,
    strategyId: r.strategy_id,
    versionId: r.version_id,
    kind: r.kind,
    summary: r.summary,
    trialsAdded: r.trials_added,
    gateEligible: r.gate_eligible ?? false,
    createdAt: r.created_at.toISOString(),
    ...(full ? { request: r.request, result: r.result } : {}),
  };
}

/**
 * Backtests, walk-forward, optimisation and sensitivity (goal 06 §3–6). The api assembles the
 * point-in-time data and the registry cost model, counts trials server-side (every distinct
 * configuration evaluated for the strategy), calls the quant service, stores the run and audits it.
 */
@Injectable()
export class BacktestsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly strategies: StrategiesService,
    private readonly data: ResearchDataService,
    private readonly quant: ResearchClient,
    private readonly accounts: AccountsService,
  ) {}

  private async prepare(userId: string, roles: Role[], kind: Kind, req: BacktestRequest) {
    const { version, strategy } = await this.strategies.version(userId, roles, req.versionId);
    if (strategy.owner_id !== userId)
      throw new NotFoundException({ error: 'not_found', message: 'Strategy version not found.' });
    const def = version.definition;
    const symbols = req.symbols ?? def.universe.symbols;
    const account = await this.accounts.ensure(userId);
    const data: SymbolDataWire[] = [];
    for (const s of symbols)
      data.push(
        await this.data.symbolData(s, def.universe.timeframe, account.base_currency, {
          from: req.from,
          to: req.to,
          spreadTicks: req.spreadTicks,
        }),
      );
    if (data.every((d) => d.bars.t.length < 10))
      throw new BadRequestException({
        error: 'not_enough_data',
        message: `Not enough ${def.universe.timeframe} history for ${symbols.join(', ')} (${data.map((d) => d.bars.t.length).join('/')} bars). Pick a shorter timeframe or wait for more data.`,
      });
    const trials = await this.db.query<{ config_hash: string; is_period_sharpe: number | null }>(
      'SELECT config_hash, is_period_sharpe FROM strategy_trials WHERE strategy_id = $1',
      [strategy.id],
    );
    const kept = data.filter((d) => d.bars.t.length > 0);
    return {
      version,
      strategy,
      def,
      data: kept,
      trials,
      context: trialContext(kind, req, kept),
      evidence: evidenceEligibility(kind, req, def.universe.symbols),
      baseCurrency: account.base_currency,
    };
  }

  private body(
    req: BacktestRequest,
    prep: Awaited<ReturnType<BacktestsService['prepare']>>,
    extra: Record<string, unknown>,
  ) {
    const current = trialKey(
      strategyContentHash(withParams(prep.def, req.paramOverrides)),
      prep.context,
    );
    const others = prep.trials.filter((t) => t.config_hash !== current);
    return {
      definition: prep.def,
      paramOverrides: req.paramOverrides,
      data: prep.data,
      capital: Number(req.capital),
      split: req.split,
      trials: {
        count: others.length,
        periodSharpes: others.map((t) => t.is_period_sharpe).filter((x): x is number => x !== null),
      },
      // Goal 07B: the ai_regime condition reads the scanner's point-in-time regime model.
      aiRegime: loadIntelConfig().aiRegime,
      ...extra,
    };
  }

  private async record(
    userId: string,
    kind: Kind,
    version: VersionRow,
    req: Record<string, unknown>,
    result: QuantResult,
    summary: Record<string, unknown>,
    context: TrialContext,
    evidence: { eligible: boolean; reasons: string[] },
  ) {
    return this.db.tx(async (c) => {
      const run = (
        await c.query<RunRow>(
          `INSERT INTO backtest_runs (strategy_id, version_id, user_id, kind, request, summary, result, trials_added, gate_eligible, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9) RETURNING *`,
          [
            version.strategy_id,
            version.id,
            userId,
            kind,
            JSON.stringify(req),
            JSON.stringify(summary),
            JSON.stringify(result),
            evidence.eligible,
            JSON.stringify({ reasons: evidence.reasons, trialContext: context }),
          ],
        )
      ).rows[0]!;
      let added = 0;
      for (const t of result.trialStats) {
        const hash = trialKey(
          strategyContentHash(withParams(version.definition, t.params)),
          context,
        );
        const ins = await c.query(
          `INSERT INTO strategy_trials (strategy_id, config_hash, params, version_id, run_id, is_period_sharpe, oos_period_sharpe, is_sharpe, oos_sharpe, observations, context)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (strategy_id, config_hash) DO NOTHING`,
          [
            version.strategy_id,
            hash,
            JSON.stringify(t.params),
            version.id,
            run.id,
            t.isPeriodSharpe,
            t.oosPeriodSharpe,
            t.isSharpe,
            t.oosSharpe,
            t.observations,
            JSON.stringify(context),
          ],
        );
        added += ins.rowCount ?? 0;
      }
      const total = Number(
        (
          await c.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM strategy_trials WHERE strategy_id = $1',
            [version.strategy_id],
          )
        ).rows[0]!.n,
      );
      const auditEvent = await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: `backtest.${kind === 'backtest' ? 'run' : kind}`,
          entity: 'strategy',
          entityId: version.strategy_id,
          payload: {
            runId: run.id,
            strategyId: version.strategy_id,
            versionId: version.id,
            version: version.version,
            contentHash: version.content_hash,
            trialsAdded: added,
            trialsTotal: total,
            gateEligible: evidence.eligible,
            simulated: true,
            ...(Object.fromEntries(
              Object.entries(summary).filter(
                ([, v]) =>
                  typeof v === 'string' ||
                  typeof v === 'boolean' ||
                  (typeof v === 'number' && Number.isSafeInteger(v)),
              ),
            ) as Record<string, string | number | boolean>),
          },
        },
        c,
      );
      return { run, added, total, auditEventId: auditEvent.id };
    });
  }

  private async execute(
    userId: string,
    roles: Role[],
    kind: Kind,
    req: BacktestRequest,
    extra: Record<string, unknown>,
  ) {
    const prep = await this.prepare(userId, roles, kind, req);
    const body = this.body(req, prep, extra);
    const result = await this.quant.post<QuantResult>(PATHS[kind], body);
    const summary = summarise(kind, result, prep);
    const { run, added, total, auditEventId } = await this.record(
      userId,
      kind,
      prep.version,
      req as unknown as Record<string, unknown>,
      result,
      summary,
      prep.context,
      prep.evidence,
    );
    return {
      runId: run.id,
      kind,
      strategyId: prep.strategy.id,
      versionId: prep.version.id,
      version: prep.version.version,
      contentHash: prep.version.content_hash,
      shortHash: shortHash(prep.version.content_hash),
      trialsAdded: added,
      trialsTotal: total,
      gateEligible: prep.evidence.eligible,
      gateIneligibleReasons: prep.evidence.reasons,
      auditEventId,
      baseCurrency: prep.baseCurrency,
      ...result,
    };
  }

  backtest(userId: string, roles: Role[], req: BacktestRequest) {
    return this.execute(userId, roles, 'backtest', req, {});
  }

  walkForward(userId: string, roles: Role[], req: WalkForwardRequest) {
    return this.execute(userId, roles, 'walk_forward', req, {
      mode: req.mode,
      folds: req.folds,
      trainFraction: req.trainFraction,
      ...(req.grid ? { grid: req.grid } : {}),
    });
  }

  optimise(userId: string, roles: Role[], req: OptimiseRequest) {
    return this.execute(userId, roles, 'optimise', req, {
      method: req.method,
      grid: req.grid,
      samples: req.samples,
      seed: req.seed,
      validationFraction: req.validationFraction,
      ...(req.maxCombos ? { maxCombos: req.maxCombos } : {}),
    });
  }

  sensitivity(userId: string, roles: Role[], req: SensitivityRequest) {
    return this.execute(userId, roles, 'sensitivity', req, {
      x: req.x,
      y: req.y,
      validationFraction: req.validationFraction,
    });
  }

  async list(
    userId: string,
    roles: Role[],
    q: { strategyId?: string; kind?: Kind; limit?: number },
  ) {
    const params: unknown[] = [userId];
    const where = ['user_id = $1'];
    if (q.strategyId) {
      await this.strategies.strategy(userId, roles, q.strategyId);
      params.push(q.strategyId);
      where.push(`strategy_id = $${params.length}`);
    }
    if (q.kind) {
      params.push(q.kind);
      where.push(`kind = $${params.length}`);
    }
    params.push(Math.min(Math.max(q.limit ?? 20, 1), 100));
    const rows = await this.db.query<RunRow>(
      `SELECT id, strategy_id, version_id, user_id, kind, request, summary, '{}'::jsonb AS result, trials_added, created_at
       FROM backtest_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { runs: rows.map((r) => runDto(r, false)) };
  }

  async get(userId: string, roles: Role[], id: string) {
    const r = (await this.db.query<RunRow>('SELECT * FROM backtest_runs WHERE id = $1', [id]))[0];
    if (!r || (r.user_id !== userId && !hasAnyRole(roles, AUDIT_READ_ALL_ROLES)))
      throw new NotFoundException({ error: 'not_found', message: 'Backtest not found.' });
    return runDto(r, true);
  }

  /** Out-of-sample (or in-sample) R multiples of a run, for "Send to Monte Carlo" (B-502). */
  async tradeList(userId: string, roles: Role[], id: string, segment: 'oos' | 'is' | 'wf') {
    const run = await this.get(userId, roles, id);
    const trades = (
      (run.result as { trades?: Array<{ segment: string; rMultiple: number }> }).trades ?? []
    ).filter((t) => t.segment === segment);
    return {
      runId: id,
      kind: run.kind,
      segment,
      source: segment === 'is' ? 'backtest_in_sample' : 'backtest_out_of_sample',
      trades: trades.map((t) => t.rMultiple),
      simulated: true,
    };
  }

  /**
   * Promotion evidence (IRTC R3-02): the latest *gate-eligible* backtest of a version, i.e. its own
   * parameters and universe, all available history, the default holdout and registry costs.
   */
  async latestEvidenceBacktest(versionId: string): Promise<RunRow | null> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM backtest_runs WHERE version_id = $1 AND kind = 'backtest' AND gate_eligible
       ORDER BY created_at DESC LIMIT 1`,
      [versionId],
    );
    return r[0] ?? null;
  }

  /** Every trial recorded for a strategy (count and in-sample per-period Sharpes, for the DSR). */
  async trialStats(strategyId: string): Promise<{ count: number; periodSharpes: number[] }> {
    const rows = await this.db.query<{ is_period_sharpe: number | null }>(
      'SELECT is_period_sharpe FROM strategy_trials WHERE strategy_id = $1',
      [strategyId],
    );
    return {
      count: rows.length,
      periodSharpes: rows.map((r) => r.is_period_sharpe).filter((x): x is number => x !== null),
    };
  }

  /** Latest standard backtest of a version (copilot and calibration context, not promotion). */
  async latestBacktest(versionId: string): Promise<RunRow | null> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM backtest_runs WHERE version_id = $1 AND kind = 'backtest' ORDER BY created_at DESC LIMIT 1`,
      [versionId],
    );
    return r[0] ?? null;
  }
}

function summarise(
  kind: Kind,
  r: QuantResult,
  prep: { data: SymbolDataWire[]; def: { universe: { timeframe: string } } },
): Record<string, unknown> {
  const base = {
    symbols: prep.data.map((d) => d.symbol).join(','),
    timeframe: prep.def.universe.timeframe,
    bars: Math.max(0, ...prep.data.map((d) => d.bars.t.length)),
  };
  const m = r.metrics as
    | ({ outOfSample?: Record<string, unknown>; inSample?: Record<string, unknown> } & Record<
        string,
        unknown
      >)
    | undefined;
  if (kind === 'backtest')
    return {
      ...base,
      oosTrades: (m?.outOfSample?.trades as number) ?? 0,
      isTrades: (m?.inSample?.trades as number) ?? 0,
      oosSharpe: m?.outOfSample?.sharpe ?? null,
      isSharpe: m?.inSample?.sharpe ?? null,
      dsr: (r.overfitting as { dsr?: number | null } | undefined)?.dsr ?? null,
      // Holdout moments: the promotion checklist deflates them with the trial count at check time.
      oosPeriodSharpe: m?.outOfSample?.periodSharpe ?? null,
      oosObservations: (m?.outOfSample?.observations as number) ?? 0,
      oosSkew: m?.outOfSample?.skew ?? null,
      oosKurtosis: m?.outOfSample?.kurtosis ?? null,
      holdoutDsr:
        (r.overfitting as { holdout?: { dsr?: number | null } } | undefined)?.holdout?.dsr ?? null,
      warnings: ((r.warnings as Array<{ code: string }>) ?? []).map((w) => w.code).join(','),
    };
  if (kind === 'walk_forward')
    return {
      ...base,
      folds: (r.folds as unknown[]).length,
      wfTrades: (m?.trades as number) ?? 0,
      wfSharpe: m?.sharpe ?? null,
    };
  if (kind === 'optimise') {
    // IRTC R3-01: ranked on validation; the holdout was scored once, for the selected combination.
    const best = r.best as {
      validationSharpe?: number | null;
      holdout?: { sharpe?: number | null };
    } | null;
    return {
      ...base,
      evaluated: r.evaluated as number,
      rankedBy: (r.rankedBy as string) ?? 'validation_sharpe',
      bestValidationSharpe: best?.validationSharpe ?? null,
      bestHoldoutSharpe: best?.holdout?.sharpe ?? null,
    };
  }
  return { ...base, cells: (r.cells as unknown[][]).flat().length };
}
