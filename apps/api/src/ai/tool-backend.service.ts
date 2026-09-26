import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { atr, ema, PreviewOrderSchema, quoteChannel, rsi, sma, type Quote } from '@kora/domain';
import { SimulatedCalendarProvider } from '@kora/market-data';

import { CandlesService } from '../market-data/candles.service';
import { ChannelHub } from '../market-data/channel-hub';
import { MD_CONFIG, type MdConfig } from '../market-data/md-config';
import { FromTradesRequestSchema } from '../sim/sim.schemas';
import { QuantClient } from '../sim/quant.client';
import { AccountsService } from '../trading/accounts.service';
import { CalibrationService } from './calibration.service';
import { loadAiConfig } from './core/config';
import type { ToolBackend, ToolCallCtx, ToolInput } from './core/tools';
import { DraftsService } from './drafts.service';
import { AiReadPorts } from './read-ports';

const IMPACT = { 1: 'low', 2: 'medium', 3: 'high' } as const;
const r6 = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6;

/**
 * DB-backed implementation of the copilot tools. Every function acts **as the requesting user**
 * (same visibility rules as the REST endpoints). Read-only, except the two draft tools which write
 * only draft rows.
 */
@Injectable()
export class AiToolBackend implements ToolBackend {
  private readonly calendar: SimulatedCalendarProvider;

  constructor(
    private readonly candles: CandlesService,
    private readonly hub: ChannelHub,
    private readonly accounts: AccountsService,
    private readonly ports: AiReadPorts,
    private readonly calibration: CalibrationService,
    private readonly drafts: DraftsService,
    private readonly quant: QuantClient,
    @Inject(MD_CONFIG) md: MdConfig,
  ) {
    this.calendar = new SimulatedCalendarProvider(md.seed);
  }

  async get_quote(_: ToolCallCtx, i: ToolInput<'get_quote'>) {
    const spec = await this.candles.spec(i.symbol);
    const [raw] = await this.hub.getLast([quoteChannel(i.symbol)]);
    const q = raw ? (JSON.parse(raw) as Quote) : null;
    const opens = await this.candles.dayOpens([i.symbol]);
    return {
      symbol: spec.symbol,
      simulated: true,
      quote: q ? { bid: q.bid, ask: q.ask, stale: q.stale } : null,
      dayOpen: opens.get(i.symbol) ?? null,
      quoteCcy: spec.quoteCcy,
    };
  }

  async get_candles(_: ToolCallCtx, i: ToolInput<'get_candles'>) {
    const c = await this.candles.get({ symbol: i.symbol, tf: i.timeframe, limit: i.limit });
    return {
      symbol: c.symbol,
      timeframe: c.tf,
      simulated: true,
      candles: c.candles.map((x) => ({
        time: new Date(x.t).toISOString(),
        open: x.open,
        high: x.high,
        low: x.low,
        close: x.close,
        volume: x.volume,
      })),
    };
  }

  async get_indicators(_: ToolCallCtx, i: ToolInput<'get_indicators'>) {
    const bars = await this.calibration.loadBars(i.symbol, i.timeframe, 200);
    const closes = bars.map((b) => b.close);
    const last = <T>(xs: T[]) => xs[xs.length - 1];
    const calc: Record<string, () => number | null> = {
      ema20: () => last(ema(closes, 20)) ?? null,
      ema50: () => last(ema(closes, 50)) ?? null,
      sma20: () => last(sma(closes, 20)) ?? null,
      rsi14: () => last(rsi(closes, 14)) ?? null,
      atr14: () => last(atr(bars, 14)) ?? null,
    };
    return {
      symbol: i.symbol,
      timeframe: i.timeframe,
      bars: bars.length,
      asOf: bars.length ? new Date(bars[bars.length - 1]!.t).toISOString() : null,
      values: Object.fromEntries(i.indicators.map((k) => [k, r6(calc[k]!())])),
      simulated: true,
    };
  }

  async get_positions(ctx: ToolCallCtx) {
    const a = await this.accounts.ensure(ctx.user.id);
    const ps = await this.accounts.positionsView(a);
    return {
      environment: 'PAPER',
      baseCurrency: a.base_currency,
      positions: ps.map((p) => ({
        symbol: p.symbol,
        side: p.qty.startsWith('-') ? 'short' : 'long',
        qty: p.qty.replace(/^-/, ''),
        avgPrice: p.avgPrice,
        mark: p.markPrice,
        unrealizedPnl: p.unrealizedPnl,
      })),
    };
  }

  async get_account_risk(ctx: ToolCallCtx) {
    const a = await this.accounts.ensure(ctx.user.id);
    const v = await this.accounts.view(a);
    const dayPnl = v.dayPnl;
    return {
      environment: 'PAPER',
      currency: v.baseCurrency,
      equity: v.equity,
      cash: v.cash,
      marginUsed: v.marginUsed,
      freeMargin: v.marginFree,
      marginUsedPct: v.marginUsedPct,
      leverage: v.leverage,
      dayPnl,
      dailyLoss: dayPnl.startsWith('-') ? dayPnl.slice(1) : '0.00',
      dailyLossLimit: v.dailyLossLimit,
      dailyLossUsedPct: v.dailyLossUsedPct,
      openPositions: v.openPositions,
      halted: v.halt.halted,
    };
  }

  async get_order_preview(ctx: ToolCallCtx, i: ToolInput<'get_order_preview'>) {
    const req = PreviewOrderSchema.parse({ ...i });
    const pv = await this.ports.previewOrder(ctx.user.id, ctx.user.roles, req);
    return { readOnly: true, placed: false, ...pv };
  }

  async get_calendar(_: ToolCallCtx, i: ToolInput<'get_calendar'>) {
    const now = Date.now();
    const events = await this.calendar.getEvents(now, now + i.hoursAhead * 3_600_000);
    return {
      source: this.calendar.source,
      simulated: true,
      events: events.map((e) => ({
        time: e.time,
        currency: e.currency,
        impact: IMPACT[e.impact],
        title: e.title,
      })),
    };
  }

  async get_strategy(ctx: ToolCallCtx, i: ToolInput<'get_strategy'>) {
    const s = await this.ports.strategy(ctx.user.id, ctx.user.roles, i.strategyId);
    const latest = s.versions[0];
    return {
      id: s.id,
      name: s.name,
      trials: s.trials,
      latestVersion: latest
        ? {
            id: latest.id,
            version: latest.version,
            shortHash: latest.shortHash,
            reason: latest.reason,
            createdAt: latest.createdAt,
          }
        : null,
      definition: latest?.definition ?? null,
      versions: s.versions
        .slice(0, 5)
        .map((v) => ({ version: v.version, shortHash: v.shortHash, createdAt: v.createdAt })),
    };
  }

  async get_backtest_results(ctx: ToolCallCtx, i: ToolInput<'get_backtest_results'>) {
    const s = await this.ports.strategy(ctx.user.id, ctx.user.roles, i.strategyId);
    const latest = s.versions[0];
    const bt = latest ? await this.ports.latestBacktest(latest.id) : null;
    if (!bt)
      throw new NotFoundException({
        error: 'no_backtest',
        message: 'This strategy version has no backtest yet.',
      });
    const res = bt.result as {
      metrics?: { inSample?: Record<string, unknown>; outOfSample?: Record<string, unknown> };
      overfitting?: Record<string, unknown>;
      warnings?: Array<{ code: string; message?: string }>;
    };
    const pick = (m?: Record<string, unknown>) =>
      m
        ? Object.fromEntries(
            Object.entries(m).filter(([, v]) => typeof v === 'number' || v === null),
          )
        : null;
    return {
      backtestId: bt.id,
      version: latest!.version,
      netOfCosts: true,
      simulated: true,
      metrics: { is: pick(res.metrics?.inSample), oos: pick(res.metrics?.outOfSample) },
      overfitting: pick(res.overfitting),
      warnings: (res.warnings ?? []).map((w) => w.code),
      createdAt: bt.created_at.toISOString(),
    };
  }

  async get_bot_signals(ctx: ToolCallCtx, i: ToolInput<'get_bot_signals'>) {
    const detail = await this.ports.robotDetail(ctx.user.id, ctx.user.roles, i.botId);
    const { signals } = await this.ports.robotSignals(ctx.user.id, ctx.user.roles, i.botId, 200);
    const from = i.from ? Date.parse(i.from) : -Infinity;
    const to = i.to ? Date.parse(i.to) : Infinity;
    return {
      robotId: detail.id,
      name: detail.name,
      symbols: detail.symbols,
      timeframe: detail.timeframe,
      status: detail.status,
      signals: signals
        .filter((s) => {
          const t = Date.parse(String(s.barTs));
          return t >= from && t < to;
        })
        .slice(0, i.limit ?? 50)
        .map((s) => ({
          id: s.id,
          symbol: s.symbol,
          barTs: s.barTs,
          action: s.action,
          outcome: s.outcome,
        })),
    };
  }

  async get_signal_features(ctx: ToolCallCtx, i: ToolInput<'get_signal_features'>) {
    const f = await this.ports.signalFeatures(ctx.user.id, ctx.user.roles, i.signalId);
    let robotName: string | null = null;
    try {
      robotName = (await this.ports.robotDetail(ctx.user.id, ctx.user.roles, String(f.robotId)))
        .name;
    } catch {
      robotName = null;
    }
    return {
      id: f.id,
      robotName,
      symbol: f.symbol,
      barTs: f.barTs,
      action: f.action,
      reason: f.reason,
      outcome: f.outcome,
      features: f.features,
      conditions: f.conditions,
      explanation: f.explanation,
    };
  }

  async get_mc_projection(ctx: ToolCallCtx, i: ToolInput<'get_mc_projection'>) {
    const s = await this.ports.strategy(ctx.user.id, ctx.user.roles, i.strategyId);
    const latest = s.versions[0];
    const bt = latest ? await this.ports.latestBacktest(latest.id) : null;
    const trades = (
      (bt?.result as { trades?: Array<{ segment: string; rMultiple: number }> } | undefined)
        ?.trades ?? []
    )
      .filter((t) => t.segment === 'oos')
      .map((t) => t.rMultiple);
    if (trades.length < 2)
      throw new NotFoundException({
        error: 'not_enough_trades',
        message: 'Not enough out-of-sample trades for a projection.',
      });
    const body = FromTradesRequestSchema.parse({ trades, source: 'backtest_out_of_sample' });
    const r = await this.quant.post<{
      finalEquity?: Record<string, number>;
      probEndBelowStart?: number;
      maxDrawdown?: Record<string, number>;
    }>('/mc/from-trades', body);
    return {
      source: 'backtest_out_of_sample',
      trades: trades.length,
      costsIncluded: true,
      simulated: true,
      finalEquity: r.finalEquity ?? null,
      probEndBelowStart: r.probEndBelowStart ?? null,
    };
  }

  async get_calibration(ctx: ToolCallCtx, i: ToolInput<'get_calibration'>) {
    await this.calibration.assertAccess(ctx.user.id, ctx.user.roles, i.modelKey);
    if (i.modelKey.startsWith('strategy:'))
      await this.calibration.ensureStrategy(ctx.user.id, ctx.user.roles, i.modelKey.slice(9));
    const v = await this.calibration.view(i.modelKey, i.rawScore, loadAiConfig().calibrationMinN);
    return { ...v, bins: v.bins.filter((b) => b.n > 0) };
  }

  create_order_draft(ctx: ToolCallCtx, i: ToolInput<'create_order_draft'>) {
    return this.drafts.createOrderDraft(ctx, i);
  }

  create_strategy_draft(ctx: ToolCallCtx, i: ToolInput<'create_strategy_draft'>) {
    return this.drafts.createStrategyDraft(ctx, i);
  }
}
