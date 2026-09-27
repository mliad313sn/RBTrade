import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  TIMEFRAME_SECONDS,
  barInSession,
  currencyDecimals,
  sessionBarsPerYear,
  sessionState,
  type StrategyTimeframe,
} from '@kora/domain';
import { SimulatedCalendarProvider, simProfileFor } from '@kora/market-data';

import { CandlesService } from '../market-data/candles.service';
import { MD_CONFIG, type MdConfig } from '../market-data/md-config';
import { FxService } from '../trading/fx.service';
import {
  TradingRegistryService,
  type TradableInstrument,
} from '../trading/trading-registry.service';

/** Cost model sent to the quant service: the paper engine's registry rows, nothing else (ADR 0006). */
export interface CostModelWire {
  tickSize: number;
  pricePrecision: number;
  qtyStep: string;
  minQty: string;
  multiplier: number;
  commissionBps: number;
  commissionPerUnit: number;
  commissionMin: number;
  swapLongBps: number;
  swapShortBps: number;
  impactTicks: number;
  volFactor: number;
  spreadTicks: number;
  fxToBase: number;
  currencyDecimals: number;
  simulated: boolean;
}

export interface SymbolDataWire {
  symbol: string;
  bars: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };
  sessionOpen: boolean[];
  events: number[];
  costs: CostModelWire;
  /**
   * IRTC R3-06: bars a year from the venue session calendar when the bars follow it (omitted for a
   * 24/7 calendar or a feed that runs outside the sessions: the quant service then uses 365 days).
   */
  barsPerYear?: number;
}

/** Share of bars that must fall in trading time for the calendar to describe the data. */
const CALENDAR_SHARE = 0.95;

export function maxBars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KORA_BT_MAX_BARS ?? '');
  return Number.isInteger(n) && n > 0 ? Math.min(n, 60_000) : 20_000;
}

/**
 * Point-in-time research data for the backtester and the live signal: SIMULATED candles from the
 * goal 02 store, per-bar venue session flags from the registry calendar, high-impact events from the
 * SIMULATED calendar, and the registry cost model. Works for any instrument in the registry.
 */
@Injectable()
export class ResearchDataService {
  private readonly calendar: SimulatedCalendarProvider;

  constructor(
    private readonly candles: CandlesService,
    private readonly registry: TradingRegistryService,
    private readonly fx: FxService,
    @Inject(MD_CONFIG) md: MdConfig,
  ) {
    this.calendar = new SimulatedCalendarProvider(md.seed);
  }

  async costModel(
    inst: TradableInstrument,
    baseCcy: string,
    spreadTicks?: number,
  ): Promise<CostModelWire> {
    const s = inst.spec;
    const rate = await this.fx.rate(s.quoteCcy, baseCcy);
    if (!rate)
      throw new BadRequestException({
        error: 'fx_rate_unavailable',
        message: `No ${s.quoteCcy}→${baseCcy} rate right now, so costs cannot be converted. Try again when the market data is live.`,
      });
    return {
      tickSize: Number(s.tickSize),
      pricePrecision: s.pricePrecision,
      qtyStep: s.qtyStep,
      minQty: s.minQty,
      multiplier: Number(inst.multiplier.toFixed()),
      commissionBps: Number(inst.fees.commissionBps),
      commissionPerUnit: Number(inst.fees.commissionPerUnit),
      commissionMin: Number(inst.fees.commissionMin),
      swapLongBps: Number(inst.fees.swapLongBps),
      swapShortBps: Number(inst.fees.swapShortBps),
      impactTicks: Number(inst.trading.impactTicks),
      volFactor: Number(inst.trading.volFactor),
      spreadTicks: spreadTicks ?? simProfileFor(s).spreadTicks,
      fxToBase: Number(rate.rate.toFixed(10)),
      currencyDecimals: currencyDecimals(s.quoteCcy),
      simulated: inst.fees.simulated || inst.trading.simulated,
    };
  }

  async symbolData(
    symbol: string,
    tf: StrategyTimeframe,
    baseCcy: string,
    opts: { from?: number; to?: number; limit?: number; spreadTicks?: number } = {},
  ): Promise<SymbolDataWire> {
    const inst = await this.registry.find(symbol);
    if (!inst)
      throw new BadRequestException({
        error: 'unknown_symbol',
        message: `Unknown instrument ${symbol}.`,
      });
    const res = await this.candles.get({
      symbol,
      tf,
      limit: Math.min(opts.limit ?? maxBars(), maxBars()),
      from: opts.from,
      to: opts.to,
    });
    const cal = inst.spec.tradingSessions ?? inst.venue.calendar;
    const tz = inst.spec.tradingSessions?.timezone ?? inst.venue.timezone;
    const bars = {
      t: [] as number[],
      o: [] as number[],
      h: [] as number[],
      l: [] as number[],
      c: [] as number[],
      v: [] as number[],
    };
    const sessionOpen: boolean[] = [];
    for (const k of res.candles) {
      bars.t.push(k.t);
      bars.o.push(Number(k.open));
      bars.h.push(Number(k.high));
      bars.l.push(Number(k.low));
      bars.c.push(Number(k.close));
      bars.v.push(Number(k.volume));
      sessionOpen.push(sessionState(cal, tz, k.t) === 'open');
    }
    const tfSeconds = TIMEFRAME_SECONDS[tf];
    // Up to 256 evenly spaced bars decide whether the data follows the calendar (Intl is costly).
    const step = Math.max(1, Math.ceil(bars.t.length / 256));
    const sample = bars.t.filter((_, i) => i % step === 0);
    const inSession = sample.filter((t) => barInSession(cal, tz, t, tfSeconds)).length;
    const lastT = bars.t.length ? bars.t[bars.t.length - 1]! : Date.now();
    const calendarBpy = sessionBarsPerYear(cal, tfSeconds, lastT);
    const continuousBpy = (365 * 86_400) / tfSeconds;
    const followsCalendar = sample.length > 0 && inSession >= CALENDAR_SHARE * sample.length;
    const barsPerYear =
      followsCalendar && Math.abs(calendarBpy - continuousBpy) > 1e-9 ? calendarBpy : undefined;
    const events: number[] = [];
    if (bars.t.length) {
      const ccys = new Set([inst.spec.quoteCcy, inst.spec.baseCcy].filter((x): x is string => !!x));
      const from = bars.t[0]! - 86_400_000;
      const to = bars.t[bars.t.length - 1]! + 2 * 86_400_000;
      for (const e of await this.calendar.getEvents(from, to))
        if (e.impact === 3 && ccys.has(e.currency)) events.push(Date.parse(e.time));
    }
    return {
      symbol,
      bars,
      sessionOpen,
      events,
      costs: await this.costModel(inst, baseCcy, opts.spreadTicks),
      ...(barsPerYear !== undefined ? { barsPerYear } : {}),
    };
  }
}
