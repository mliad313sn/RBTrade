import { ForbiddenException, Injectable } from '@nestjs/common';
import type { OhlcvBar, Role, Timeframe } from '@kora/domain';

import { DbService } from '../db/db.service';
import { CandlesService } from '../market-data/candles.service';
import { replayBias } from './core/bias';
import {
  buildBins,
  calibrationView,
  scoreFromContributions,
  type CalibrationBin,
  type CalibrationView,
  type PredictionOutcome,
} from './core/calibration';
import { AiReadPorts } from './read-ports';

interface BinRow {
  bin: number;
  lo: string;
  hi: string;
  n: number;
  hits: number;
  mean_predicted: number | null;
  mean_net_return: number | null;
  net_return_sd: number | null;
  source: string;
  updated_at: Date;
}

const BIAS_REFRESH_MS = 60 * 60 * 1000;

/**
 * The calibration table (goal 07 §4, reused by 07B): predictions are logged with their outcome and
 * net-of-cost result; bins are rebuilt from them. Confidence shown anywhere in the UI comes from
 * `view()`, i.e. from these rows.
 */
@Injectable()
export class CalibrationService {
  constructor(
    private readonly db: DbService,
    private readonly candles: CandlesService,
    private readonly ports: AiReadPorts,
  ) {}

  async bins(
    modelKey: string,
  ): Promise<{ bins: CalibrationBin[]; source: string | null; updatedAt: Date | null }> {
    const rows = await this.db.query<BinRow>(
      'SELECT * FROM ai_calibration_bins WHERE model_key = $1 ORDER BY bin',
      [modelKey],
    );
    if (!rows.length) return { bins: buildBins([]), source: null, updatedAt: null };
    const byBin = new Map(rows.map((r) => [Number(r.bin), r]));
    const bins = buildBins([]).map((b) => {
      const r = byBin.get(b.bin);
      return r
        ? {
            ...b,
            n: r.n,
            hits: r.hits,
            meanPredicted: r.mean_predicted,
            meanNetReturn: r.mean_net_return,
            netReturnSd: r.net_return_sd,
          }
        : b;
    });
    const latest = rows.reduce(
      (a, r) => (r.updated_at > a ? r.updated_at : a),
      rows[0]!.updated_at,
    );
    return { bins, source: rows[0]!.source, updatedAt: latest };
  }

  /** Access: strategy/robot keys follow the strategy/robot visibility rules; market keys are public data. */
  async assertAccess(userId: string, roles: Role[], modelKey: string): Promise<void> {
    const [kind, id] = modelKey.split(':');
    if (kind === 'strategy' && id) await this.ports.strategy(userId, roles, id);
    else if (kind === 'robot' && id) await this.ports.robotDetail(userId, roles, id);
    else if (!['bias', 'trend', 'news'].includes(kind ?? ''))
      throw new ForbiddenException({ error: 'forbidden', message: 'Unknown calibration model.' });
  }

  async view(
    modelKey: string,
    rawScore: number | null | undefined,
    minN: number,
  ): Promise<CalibrationView> {
    const { bins, source, updatedAt } = await this.bins(modelKey);
    return calibrationView(modelKey, bins, {
      rawScore,
      minN,
      source,
      updatedAt: updatedAt?.toISOString() ?? null,
    });
  }

  /** Rebuilds the bins of a model from its resolved predictions. */
  async rebuild(modelKey: string, source: string): Promise<number> {
    const rows = await this.db.query<{
      predicted: string;
      outcome: boolean;
      net_return: number | null;
    }>(
      'SELECT predicted, outcome, net_return FROM ai_predictions WHERE model_key = $1 AND outcome IS NOT NULL',
      [modelKey],
    );
    const bins = buildBins(
      rows.map(
        (r): PredictionOutcome => ({
          predicted: Number(r.predicted),
          outcome: r.outcome,
          netReturn: r.net_return,
        }),
      ),
    );
    await this.db.tx(async (c) => {
      await c.query('DELETE FROM ai_calibration_bins WHERE model_key = $1', [modelKey]);
      for (const b of bins) {
        await c.query(
          `INSERT INTO ai_calibration_bins (model_key, bin, lo, hi, n, hits, mean_predicted, mean_net_return, net_return_sd, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            modelKey,
            b.bin,
            b.lo.toFixed(2),
            b.hi.toFixed(2),
            b.n,
            b.hits,
            b.meanPredicted,
            b.meanNetReturn,
            b.netReturnSd,
            source,
          ],
        );
      }
    });
    return rows.length;
  }

  private async insertPredictions(
    modelKey: string,
    source: 'backtest_oos' | 'history_replay' | 'live' | 'seed',
    horizon: string,
    rows: Array<{
      subject: string;
      predicted: number;
      outcome: boolean | null;
      netReturn: number | null;
      predictedAt: Date;
      resolvedAt: Date | null;
      meta?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await this.db.query(
        `INSERT INTO ai_predictions (model_key, subject, horizon, predicted, outcome, net_return, source, predicted_at, resolved_at, meta)
         SELECT $1, u.subject, $2, u.predicted, u.outcome, u.net_return, $3, u.predicted_at, u.resolved_at, u.meta
         FROM unnest($4::text[], $5::numeric[], $6::boolean[], $7::float8[], $8::timestamptz[], $9::timestamptz[], $10::jsonb[])
           AS u(subject, predicted, outcome, net_return, predicted_at, resolved_at, meta)
         ON CONFLICT (model_key, subject, predicted_at) DO NOTHING`,
        [
          modelKey,
          horizon,
          source,
          chunk.map((r) => r.subject),
          chunk.map((r) => r.predicted.toFixed(5)),
          chunk.map((r) => r.outcome),
          chunk.map((r) => r.netReturn),
          chunk.map((r) => r.predictedAt.toISOString()),
          chunk.map((r) => r.resolvedAt?.toISOString() ?? null),
          chunk.map((r) => JSON.stringify(r.meta ?? {})),
        ],
      );
    }
  }

  /**
   * `bias:<symbol>:<tf>`: replays the strip's bias rule over the SIMULATED history (net of the
   * current spread) when the bins are missing or older than an hour. Seeded or fresh bins are kept.
   */
  async ensureBias(
    symbol: string,
    tf: Timeframe,
    spread: number,
    bars?: OhlcvBar[],
  ): Promise<string> {
    const modelKey = `bias:${symbol}:${tf}`;
    const { updatedAt } = await this.bins(modelKey);
    if (updatedAt && Date.now() - updatedAt.getTime() < BIAS_REFRESH_MS) return modelKey;
    const series = bars ?? (await this.loadBars(symbol, tf, 1000));
    const replay = replayBias(series, spread);
    await this.insertPredictions(
      modelKey,
      'history_replay',
      '4 bars',
      replay.map((r) => ({
        subject: `${symbol}:${tf}`,
        predicted: r.predicted,
        outcome: r.outcome,
        netReturn: r.netReturn,
        predictedAt: new Date(r.t),
        resolvedAt: new Date(r.t),
      })),
    );
    await this.rebuild(modelKey, 'history_replay');
    return modelKey;
  }

  async loadBars(symbol: string, tf: Timeframe, limit: number): Promise<OhlcvBar[]> {
    const res = await this.candles.get({ symbol, tf, limit });
    return res.candles.map((c) => ({
      t: c.t,
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }));
  }

  /**
   * `strategy:<id>`: the out-of-sample trades of the latest backtest of the current version. Raw
   * score = mean entry-condition contribution mapped to 0…1; outcome = net P&L > 0; net = R multiple.
   */
  async ensureStrategy(
    userId: string,
    roles: Role[],
    strategyId: string,
    force = false,
  ): Promise<string> {
    const modelKey = `strategy:${strategyId}`;
    const { updatedAt } = await this.bins(modelKey);
    const s = await this.ports.strategy(userId, roles, strategyId);
    const latest = s.versions[0];
    if (!latest) return modelKey;
    const bt = await this.ports.latestBacktest(latest.id);
    if (!bt) return modelKey;
    if (updatedAt && !force && updatedAt >= bt.created_at) return modelKey;
    const trades = ((bt.result as { trades?: Array<Record<string, unknown>> }).trades ?? []).filter(
      (t) => t.segment === 'oos',
    );
    const rows = trades
      .map((t, i) => {
        const conds = (
          (
            t.entrySignal as
              | { conditions?: Array<{ contribution?: number | null; result?: unknown }> }
              | undefined
          )?.conditions ?? []
        ).filter((c) => c.result === true);
        const score = scoreFromContributions(conds.map((c) => c.contribution));
        const net = Number(t.netPnl);
        if (score === null || !Number.isFinite(net)) return null;
        return {
          subject: `${latest.id}:${bt.id}:${i}`,
          predicted: score,
          outcome: net > 0,
          netReturn: Number(t.rMultiple),
          predictedAt: new Date(Number(t.entryTs)),
          resolvedAt: new Date(Math.max(Number(t.exitTs), Number(t.entryTs))),
          meta: { symbol: t.symbol, side: t.side },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    await this.insertPredictions(modelKey, 'backtest_oos', 'trade', rows);
    await this.rebuild(modelKey, 'backtest_oos');
    return modelKey;
  }
}
