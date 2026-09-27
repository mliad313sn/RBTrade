import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AUDIT_READ_ALL_ROLES,
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

  private async prepare(userId: string, roles: Role[], req: BacktestRequest) {
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
    return {
      version,
      strategy,
      def,
      data: data.filter((d) => d.bars.t.length > 0),
      trials,
      baseCurrency: account.base_currency,
    };
  }

  private body(
    req: BacktestRequest,
    prep: Awaited<ReturnType<BacktestsService['prepare']>>,
    extra: Record<string, unknown>,
  ) {
    const current = strategyContentHash(withParams(prep.def, req.paramOverrides));
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
  ) {
    return this.db.tx(async (c) => {
      const run = (
        await c.query<RunRow>(
          `INSERT INTO backtest_runs (strategy_id, version_id, user_id, kind, request, summary, result, trials_added)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING *`,
          [
            version.strategy_id,
            version.id,
            userId,
            kind,
            JSON.stringify(req),
            JSON.stringify(summary),
            JSON.stringify(result),
          ],
        )
      ).rows[0]!;
      let added = 0;
      for (const t of result.trialStats) {
        const hash = strategyContentHash(withParams(version.definition, t.params));
        const ins = await c.query(
          `INSERT INTO strategy_trials (strategy_id, config_hash, params, version_id, run_id, is_period_sharpe, oos_period_sharpe, is_sharpe, oos_sharpe, observations)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (strategy_id, config_hash) DO NOTHING`,
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
    const prep = await this.prepare(userId, roles, req);
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

  /** Latest standard backtest of a version (promotion evidence). */
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
