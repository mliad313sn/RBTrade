import { Inject, Injectable } from '@nestjs/common';
import {
  dec,
  PreviewOrderSchema,
  quoteChannel,
  roundQtyDown,
  roundToTick,
  type Quote,
  type Timeframe,
} from '@kora/domain';
import { SimulatedCalendarProvider } from '@kora/market-data';

import { ChannelHub } from '../market-data/channel-hub';
import { MD_CONFIG, type MdConfig } from '../market-data/md-config';
import { FxService } from '../trading/fx.service';
import { TradingRegistryService } from '../trading/trading-registry.service';
import { CalibrationService } from './calibration.service';
import { biasSeries } from './core/bias';
import type { AiConfig } from './core/config';
import type { ToolCallCtx } from './core/tools';
import { DISCLAIMER } from './core/types';
import { DraftsService } from './drafts.service';
import { AiReadPorts } from './read-ports';

const SIZE_CODES = new Set([
  'INSUFFICIENT_MARGIN',
  'MAX_LEVERAGE',
  'MAX_ORDER_NOTIONAL',
  'MAX_POSITION',
  'FAT_FINGER',
]);

/**
 * Terminal AI strip (goal 07 §5): bias, calibrated confidence (or "No edge after costs"), top drivers
 * and event risk, all computed from data; no model call is needed to render it. "Draft to ticket"
 * creates an audited order draft (ATR stop/target, size from the account's equity and the draft
 * risk %) that the user reviews and confirms in the ticket.
 */
@Injectable()
export class StripService {
  private readonly calendar: SimulatedCalendarProvider;

  constructor(
    private readonly calibration: CalibrationService,
    private readonly hub: ChannelHub,
    private readonly registry: TradingRegistryService,
    private readonly drafts: DraftsService,
    private readonly fx: FxService,
    private readonly ports: AiReadPorts,
    @Inject(MD_CONFIG) md: MdConfig,
  ) {
    this.calendar = new SimulatedCalendarProvider(md.seed);
  }

  private async quote(symbol: string): Promise<Quote | null> {
    const [raw] = await this.hub.getLast([quoteChannel(symbol)]);
    return raw ? (JSON.parse(raw) as Quote) : null;
  }

  async strip(symbol: string, tf: Timeframe, cfg: AiConfig) {
    const inst = await this.registry.get(symbol);
    const bars = await this.calibration.loadBars(symbol, tf, 1000);
    const q = await this.quote(symbol);
    const spread = q ? Number(q.ask) - Number(q.bid) : 0;
    const series = biasSeries(bars);
    const point = series[series.length - 1] ?? null;
    const modelKey = await this.calibration.ensureBias(symbol, tf, Math.max(0, spread), bars);
    const view = await this.calibration.view(
      modelKey,
      point?.directionalScore ?? null,
      cfg.calibrationMinN,
    );

    const now = Date.now();
    const ccys = new Set([inst.spec.quoteCcy, inst.spec.baseCcy].filter(Boolean));
    const events = (await this.calendar.getEvents(now, now + 2 * 3_600_000))
      .filter((e) => e.impact === 3 && ccys.has(e.currency))
      .map((e) => ({
        time: e.time,
        currency: e.currency,
        title: e.title,
        minutesAway: Math.max(0, Math.round((Date.parse(e.time) - now) / 60_000)),
      }));

    return {
      symbol,
      timeframe: tf,
      simulated: true,
      bias: point
        ? { direction: point.direction, label: point.label, score: point.score }
        : { direction: 'neutral' as const, label: 'Not enough data', score: null },
      confidence: view.confidence,
      reliabilityLine: view.reliabilityLine,
      edge: view.edge,
      edgeStatement: view.edgeStatement,
      calibration: {
        modelKey,
        n: view.n,
        hitRate: view.hitRate,
        minN: view.minN,
        source: view.source,
        updatedAt: view.updatedAt,
      },
      drivers: point?.drivers ?? [],
      inputs: point?.inputs ?? null,
      eventRisk: events,
      canDraft: !!point && point.direction !== 'neutral' && !!q,
      disclaimer: DISCLAIMER,
      method:
        'Bias = logistic score of EMA 20/50 spread, 4-bar momentum and RSI 14 (ATR-scaled). Confidence = observed hit rate of past scores in the same bin, net of the spread (calibration table).',
    };
  }

  async draft(ctx: ToolCallCtx, symbol: string, tf: Timeframe, cfg: AiConfig) {
    const s = await this.strip(symbol, tf, cfg);
    if (!s.canDraft || !s.inputs || s.bias.direction === 'neutral') {
      return {
        status: 'no_draft' as const,
        message: 'There is no clear bias to draft from right now.',
      };
    }
    const inst = await this.registry.get(symbol);
    const spec = inst.spec;
    const q = (await this.quote(symbol))!;
    const side = s.bias.direction === 'long' ? ('buy' as const) : ('sell' as const);
    const entry = dec(side === 'buy' ? q.ask : q.bid);
    const atrD = dec(String(s.inputs.atr14));
    const stopDist = atrD.mul('1.5');
    const sl = roundToTick(
      side === 'buy' ? entry.sub(stopDist) : entry.add(stopDist),
      spec.tickSize,
    );
    const tp = roundToTick(
      side === 'buy' ? entry.add(atrD.mul(3)) : entry.sub(atrD.mul(3)),
      spec.tickSize,
    );
    const { account, view } = await this.ports.accountView(ctx.user.id);
    const riskAmount = dec(view.equity.replace(/,/g, '')).mul(cfg.draftRiskPct).div(100);
    // Loss per unit at the stop, converted from the quote currency to the account currency.
    const fx = await this.fx.rate(spec.quoteCcy, account.base_currency);
    const perUnit = stopDist.mul(inst.multiplier).mul(fx?.rate ?? 1);
    let qty = perUnit.gt(0)
      ? roundQtyDown(riskAmount.div(perUnit), spec.qtyStep)
      : dec(spec.minQty);
    if (qty.lt(dec(spec.minQty))) qty = dec(spec.minQty);
    // Respect the account's pre-trade risk rules (margin, leverage, notional): halve the size until the
    // read-only preview passes (or the minimum is reached). The ticket re-previews anyway.
    for (let i = 0; i < 8 && qty.gt(dec(spec.minQty)); i++) {
      const pv = await this.ports
        .previewOrder(
          ctx.user.id,
          ctx.user.roles,
          PreviewOrderSchema.parse({
            symbol,
            side,
            type: 'market',
            qty: qty.toFixed(),
            stopLossPrice: sl.toFixed(),
          }),
        )
        .catch(() => null);
      if (
        !pv ||
        pv.risk.ok ||
        !pv.risk.violations.some((v: { code: string }) => SIZE_CODES.has(v.code))
      )
        break;
      const half = roundQtyDown(qty.div(2), spec.qtyStep);
      qty = half.lt(dec(spec.minQty)) ? dec(spec.minQty) : half;
    }
    const conf = s.confidence
      ? `calibrated ${s.confidence.value}, n=${s.confidence.n}`
      : s.edgeStatement;
    const draft = await this.drafts.createOrderDraft(
      { ...ctx, surface: 'strip' },
      {
        symbol,
        side,
        type: 'market',
        qty: qty.toFixed(),
        stopLossPrice: sl.gt(0) ? sl.toFixed() : undefined,
        takeProfitPrice: tp.gt(0) ? tp.toFixed() : undefined,
        rationale:
          `${s.bias.label} on ${tf} (${conf}). Stop 1.5 ATR, target 3 ATR, risk ${cfg.draftRiskPct}% of equity.`.slice(
            0,
            300,
          ),
      },
    );
    return { ...draft, status: 'draft' as const };
  }
}
