import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { quoteChannel, TIMEFRAME_SECONDS, type Quote } from '@kora/domain';
import { SimulatedCalendarProvider } from '@kora/market-data';

import { CalibrationService } from '../ai/calibration.service';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { CandlesService } from '../market-data/candles.service';
import { ChannelHub } from '../market-data/channel-hub';
import { InstrumentsRepository } from '../market-data/instruments.repository';
import { MD_CONFIG, type MdConfig } from '../market-data/md-config';
import { QuantClient } from '../sim/quant.client';
import { AlertsService } from './alerts.service';
import { trendModelKey } from './core/taxonomy';
import type { TrendKind } from './core/trend-card';
import { loadIntelConfig } from './intel-config';
import { IntelReadService } from './intel-read.service';

/** SIMULATED round-trip cost assumptions by asset class (fee schedules are OQ-M5). */
const COST_BY_CLASS: Record<string, number> = {
  fx: 0.0002,
  metal: 0.0004,
  crypto: 0.002,
  equity: 0.001,
  etf: 0.0005,
  index: 0.0005,
  cfd: 0.0005,
  energy: 0.0008,
  agri: 0.001,
  bond: 0.0003,
  future: 0.0004,
  option: 0.01,
  fund: 0.001,
};

interface QuantForecast {
  horizon: string;
  horizonBars: number;
  status: 'ok' | 'insufficient_data';
  skill: Record<string, unknown>;
  latest: {
    ts: number;
    pUp: number;
    pDirection: number;
    direction: 'up' | 'down';
    drivers: Array<{ feature: string; value: number; contribution: number }>;
  } | null;
  oos: Array<{
    ts: number;
    resolvedTs: number;
    pUp: number;
    pDirection: number;
    direction: 'up' | 'down';
    outcome: boolean;
    netReturn: number;
  }>;
}

interface QuantScan {
  instruments: Array<{
    symbol: string;
    barTs: number | null;
    features: Record<string, number | null>;
    trend: { kind: TrendKind; score: number } | null;
    forecasts: QuantForecast[];
  }>;
  guard: { checkpoints: number; passed: boolean };
  scanMs: number;
  elapsedMs: number;
}

export interface ScanSummary {
  scanId: string;
  timeframe: string;
  instruments: number;
  trends: number;
  forecasts: number;
  livePredictions: number;
  replayPredictions: number;
  resolved: number;
  guard: { checkpoints: number; passed: boolean };
  scanMs: number;
  elapsedMs: number;
  alerts: number;
}

/**
 * Bar-close scans of the SIMULATED universe (goal 07B §2–3, §7): candles → quant `/scanner/run`
 * (detectors, trend labels, regime, walk-forward forecasts, look-ahead guard) → stored features,
 * trends and forecasts. Live forecasts are written to `ai_predictions` at the bar close, before the
 * horizon ends, and resolved from later candles; walk-forward out-of-sample forecasts are stored as
 * `history_replay`. The calibration bins of every touched model are rebuilt afterwards.
 */
@Injectable()
export class ScanService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('IntelScan');
  private readonly calendar: SimulatedCalendarProvider;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ScanSummary> | null = null;
  private lastBucket = 0;

  constructor(
    private readonly db: DbService,
    private readonly repo: InstrumentsRepository,
    private readonly candles: CandlesService,
    private readonly hub: ChannelHub,
    private readonly quant: QuantClient,
    private readonly calibration: CalibrationService,
    private readonly read: IntelReadService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
    @Inject(MD_CONFIG) md: MdConfig,
  ) {
    this.calendar = new SimulatedCalendarProvider(md.seed);
  }

  onModuleInit(): void {
    const cfg = loadIntelConfig();
    if (!cfg.scan) return;
    this.timer = setInterval(() => void this.onTick(), cfg.scanCheckMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Scans once per newly closed bar of the scan timeframe. */
  private async onTick(): Promise<void> {
    const cfg = loadIntelConfig();
    const tfMs = TIMEFRAME_SECONDS[cfg.timeframe] * 1000;
    const closed = Math.floor(Date.now() / tfMs) * tfMs - tfMs;
    if (closed <= this.lastBucket || this.running) return;
    try {
      await this.run('bar_close');
      this.lastBucket = closed;
    } catch (err) {
      this.log.warn(`bar-close scan failed: ${(err as Error).message}`);
    }
  }

  run(trigger: 'bar_close' | 'manual' | 'test', actorId = 'system'): Promise<ScanSummary> {
    if (this.running) return this.running;
    this.running = this.scan(trigger, actorId).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async lastQuote(symbol: string): Promise<Quote | null> {
    const [raw] = await this.hub.getLast([quoteChannel(symbol)]).catch(() => [null]);
    return raw ? (JSON.parse(raw) as Quote) : null;
  }

  private async scan(
    trigger: 'bar_close' | 'manual' | 'test',
    actorId: string,
  ): Promise<ScanSummary> {
    const started = Date.now();
    const cfg = loadIntelConfig();
    const tf = cfg.timeframe;
    const tfMs = TIMEFRAME_SECONDS[tf] * 1000;
    const reg = await this.read.registry();
    const specs = (await this.repo.load()).instruments;
    const venues = (await this.repo.load()).venues;
    const now = Date.now();
    const events = (
      await this.calendar.getEvents(now - cfg.bars * tfMs, now + 7 * 86_400_000)
    ).filter((e) => e.impact === 3);

    const instruments: Array<Record<string, unknown>> = [];
    const meta = new Map<string, { lastClose: number; cost: number; region: string }>();
    for (const row of reg.values()) {
      const res = await this.candles.get({ symbol: row.symbol, tf, limit: cfg.bars + 1 });
      const bars = res.candles.filter((c) => c.t + tfMs <= now);
      if (bars.length < 30) continue;
      const spec = specs.get(row.symbol)!;
      const ccys = new Set(
        [spec.quoteCcy, spec.baseCcy, venues.get(spec.venue)?.currency].filter(Boolean),
      );
      const q = await this.lastQuote(row.symbol);
      const mid = q ? (Number(q.bid) + Number(q.ask)) / 2 : 0;
      const spreadCost = q && mid > 0 ? (Number(q.ask) - Number(q.bid)) / mid : 0;
      const cost = Math.min(0.2, Math.max(COST_BY_CLASS[row.assetClass] ?? 0.001, spreadCost));
      const last = Number(bars[bars.length - 1]!.close);
      meta.set(row.symbol, { lastClose: last, cost, region: row.region });
      instruments.push({
        symbol: row.symbol,
        sector: row.sector,
        region: row.region,
        costFraction: cost,
        events: events.filter((e) => ccys.has(e.currency)).map((e) => Date.parse(e.time)),
        bars: {
          t: bars.map((b) => b.t),
          o: bars.map((b) => Number(b.open)),
          h: bars.map((b) => Number(b.high)),
          l: bars.map((b) => Number(b.low)),
          c: bars.map((b) => Number(b.close)),
          v: bars.map((b) => Number(b.volume)),
        },
      });
    }
    if (!instruments.length)
      throw new ConflictException({
        error: 'no_history',
        message: 'No instrument has enough SIMULATED history to scan yet.',
      });

    const out = await this.quant.post<QuantScan>(
      '/scanner/run',
      {
        timeframe: tf,
        tfSeconds: TIMEFRAME_SECONDS[tf],
        instruments,
        width: cfg.bars,
        guard: true,
        guardCheckpoints: cfg.guardCheckpoints,
        forecast: { horizons: cfg.horizons, minTrain: cfg.minTrain },
      },
      { timeoutMs: Number(process.env.KORA_INTEL_TIMEOUT_MS ?? '') || 120_000 },
    );

    const touched = new Set<string>();
    let replay = 0;
    let live = 0;
    let forecasts = 0;
    const scanId = await this.db.tx(async (c) => {
      const lastBar = Math.max(...out.instruments.map((i) => i.barTs ?? 0));
      const s = await c.query<{ id: string }>(
        `INSERT INTO intel_scans (timeframe, bar_ts, instruments, scan_ms, elapsed_ms, guard_checkpoints, trigger)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
        [
          tf,
          lastBar ? new Date(lastBar).toISOString() : null,
          out.instruments.length,
          out.scanMs,
          out.elapsedMs,
          out.guard.checkpoints,
          trigger,
        ],
      );
      const id = s.rows[0]!.id;
      for (const it of out.instruments) {
        const m = meta.get(it.symbol)!;
        const barTs = it.barTs ? new Date(it.barTs).toISOString() : null;
        await c.query(
          `INSERT INTO intel_features (symbol, timeframe, bar_ts, last_close, features, scan_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (symbol, timeframe) DO UPDATE SET bar_ts = EXCLUDED.bar_ts, last_close = EXCLUDED.last_close,
             features = EXCLUDED.features, scan_id = EXCLUDED.scan_id, updated_at = clock_timestamp()`,
          [it.symbol, tf, barTs, m.lastClose, JSON.stringify(it.features), id],
        );
        if (it.trend)
          await c.query(
            'INSERT INTO intel_trends (scan_id, symbol, timeframe, kind, score, bar_ts) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, it.symbol, tf, it.trend.kind, it.trend.score, barTs],
          );
      }
      return id;
    });

    // Predictions: replayed out-of-sample forecasts (outcome known) and the live forecast (not yet).
    for (const it of out.instruments) {
      const m = meta.get(it.symbol)!;
      for (const f of it.forecasts) {
        const modelKey = trendModelKey(m.region as Parameters<typeof trendModelKey>[0], f.horizon);
        const subject = `${it.symbol}:${f.horizon}`;
        if (f.oos.length) {
          touched.add(modelKey);
          await this.calibration.insertPredictions(
            modelKey,
            'history_replay',
            f.horizon,
            f.oos.map((o) => ({
              subject,
              predicted: o.pDirection,
              outcome: o.outcome,
              netReturn: o.netReturn,
              predictedAt: new Date(o.ts),
              resolvedAt: new Date(o.resolvedTs),
              meta: { direction: o.direction, pUp: o.pUp, walkForward: true },
            })),
          );
          replay += f.oos.length;
        }
        let predictionId: string | null = null;
        if (f.status === 'ok' && f.latest && f.latest.ts <= Date.now()) {
          const ins = await this.db.query<{ id: string }>(
            `INSERT INTO ai_predictions (model_key, subject, horizon, predicted, outcome, net_return, source, predicted_at, meta)
             VALUES ($1, $2, $3, $4, NULL, NULL, 'live', $5, $6)
             ON CONFLICT (model_key, subject, predicted_at) DO NOTHING RETURNING id::text`,
            [
              modelKey,
              subject,
              f.horizon,
              f.latest.pDirection.toFixed(5),
              new Date(f.latest.ts).toISOString(),
              JSON.stringify({
                direction: f.latest.direction,
                pUp: f.latest.pUp,
                horizonBars: f.horizonBars,
                timeframe: tf,
                entryClose: m.lastClose,
                cost: m.cost,
                symbol: it.symbol,
              }),
            ],
          );
          if (ins[0]) {
            predictionId = ins[0].id;
            live += 1;
          } else {
            predictionId =
              (
                await this.db.query<{ id: string }>(
                  'SELECT id::text FROM ai_predictions WHERE model_key = $1 AND subject = $2 AND predicted_at = $3',
                  [modelKey, subject, new Date(f.latest.ts).toISOString()],
                )
              )[0]?.id ?? null;
          }
        }
        await this.db.query(
          `INSERT INTO intel_forecasts (scan_id, symbol, timeframe, horizon, horizon_bars, model_key, status, predicted_at,
             direction, p_up, p_direction, skill, drivers, prediction_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            scanId,
            it.symbol,
            tf,
            f.horizon,
            f.horizonBars,
            modelKey,
            f.status,
            f.latest ? new Date(f.latest.ts).toISOString() : null,
            f.latest?.direction ?? null,
            f.latest?.pUp ?? null,
            f.latest?.pDirection ?? null,
            JSON.stringify(f.skill),
            JSON.stringify(f.latest?.drivers ?? []),
            predictionId,
          ],
        );
        forecasts += 1;
      }
    }
    const resolved = await this.resolveDue(touched);
    for (const key of touched) await this.calibration.rebuild(key, 'walk_forward_oos+live');
    const alerts = await this.alerts.evaluate(scanId).catch((e: Error) => {
      this.log.warn(`alert evaluation failed: ${e.message}`);
      return 0;
    });
    await this.audit.record({
      actorId,
      actorType: actorId === 'system' ? 'system' : 'user',
      action: 'intel.scan',
      entity: 'intel_scan',
      entityId: scanId,
      payload: {
        trigger,
        timeframe: tf,
        instruments: out.instruments.length,
        trends: out.instruments.filter((i) => i.trend).length,
        forecasts,
        livePredictions: live,
        guardCheckpoints: out.guard.checkpoints,
        simulated: true,
      },
    });
    return {
      scanId,
      timeframe: tf,
      instruments: out.instruments.length,
      trends: out.instruments.filter((i) => i.trend).length,
      forecasts,
      livePredictions: live,
      replayPredictions: replay,
      resolved,
      guard: out.guard,
      scanMs: out.scanMs,
      elapsedMs: Date.now() - started,
      alerts,
    };
  }

  /**
   * Resolves live forecasts whose horizon has passed: outcome = the close `horizonBars` later moved
   * in the forecast direction by more than the round-trip cost. Adds the model keys it touched.
   */
  async resolveDue(touched: Set<string> = new Set()): Promise<number> {
    const due = await this.db.query<{
      id: string;
      model_key: string;
      predicted_at: Date;
      meta: Record<string, unknown>;
    }>(
      `SELECT id::text, model_key, predicted_at, meta FROM ai_predictions
        WHERE source = 'live' AND outcome IS NULL AND model_key LIKE 'trend:%'
        ORDER BY predicted_at LIMIT 500`,
    );
    let n = 0;
    for (const p of due) {
      const m = p.meta as {
        symbol?: string;
        timeframe?: string;
        horizonBars?: number;
        entryClose?: number;
        cost?: number;
        direction?: string;
      };
      if (!m.symbol || !m.timeframe || !m.horizonBars || !m.entryClose) continue;
      const tfMs = TIMEFRAME_SECONDS[m.timeframe as keyof typeof TIMEFRAME_SECONDS] * 1000;
      const target = p.predicted_at.getTime() + m.horizonBars * tfMs;
      if (target > Date.now()) continue;
      const res = await this.candles.get({
        symbol: m.symbol,
        tf: m.timeframe as keyof typeof TIMEFRAME_SECONDS,
        from: target - tfMs,
        limit: 500,
      });
      const bar = res.candles.find((c) => c.t + tfMs >= target && c.t + tfMs <= Date.now());
      if (!bar) continue;
      const dir = m.direction === 'down' ? -1 : 1;
      const net = dir * Math.log(Number(bar.close) / m.entryClose) - (m.cost ?? 0);
      await this.db.query(
        'UPDATE ai_predictions SET outcome = $2, net_return = $3, resolved_at = $4 WHERE id = $1 AND outcome IS NULL',
        [
          p.id,
          net > 0,
          net,
          new Date(Math.max(bar.t + tfMs, p.predicted_at.getTime())).toISOString(),
        ],
      );
      touched.add(p.model_key);
      n += 1;
    }
    return n;
  }
}
