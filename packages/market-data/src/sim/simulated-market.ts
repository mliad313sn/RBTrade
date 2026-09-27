import {
  dec,
  type DepthLevel,
  type DepthSnapshot,
  type InstrumentSpec,
  type Quote,
  type Trade,
} from '@kora/domain';

import { floatToPrice, floatToQty, formatSize } from '../precision.js';
import { Prng } from '../prng.js';
import type { SimProfile } from '../seed/sim-profiles.js';

/**
 * Deterministic simulated market (goal 02). Seeded geometric Brownian motion with Markov regime
 * switching (range / trend / high-vol), asset-class spreads, a depth ladder, Poisson trades and
 * scheduled event shocks. Pure function of (seed, startTs, stepMs, instruments, start prices,
 * shocks): no wall clock, no Math.random. Floats stay internal; every output price and size is
 * rounded with the instrument's registry tick/qty step and emitted as a decimal string.
 */

export const YEAR_SECONDS = 365 * 86_400;
export const DEFAULT_STEP_MS = 100;
export const DEFAULT_DEPTH_LEVELS = 10;

export type Regime = 'range' | 'trend' | 'high_vol';

export interface SimInstrument {
  spec: InstrumentSpec;
  profile: SimProfile;
  /** Overrides profile.refPrice, e.g. the last stored close so restarts are continuous. */
  startPrice?: string;
  /** Countries whose events move this instrument (venue country, index country…). */
  countries?: string[];
}

export interface EventShock {
  id: string;
  ts: number;
  country: string;
  currency: string;
  impact: 1 | 2 | 3;
}

export interface SimMarketOptions {
  seed: string | number;
  startTs: number;
  stepMs?: number;
  depthLevels?: number;
  source?: string;
  instruments: SimInstrument[];
  shocks?: EventShock[];
}

export interface SimOutput {
  symbol: string;
  quote: Quote | null;
  depth: DepthSnapshot | null;
  trades: Trade[];
  regime: Regime;
}

export interface SimStep {
  step: number;
  ts: number;
  outputs: SimOutput[];
}

const VOL_MULT: Record<Regime, number> = { range: 0.7, trend: 1, high_vol: 2.5 };
const SHOCK_JUMP_SIGMAS: Record<1 | 2 | 3, number> = { 1: 12, 2: 30, 3: 60 };
const SHOCK_STEPS_PER_IMPACT = 1500; // 2.5 min of high-vol per impact level at 100 ms steps

/** Whether an event in `country`/`currency` moves this instrument. */
export function isAffected(
  inst: SimInstrument,
  shock: Pick<EventShock, 'country' | 'currency'>,
): boolean {
  const s = inst.spec;
  if (s.baseCcy === shock.currency || s.quoteCcy === shock.currency) return true;
  if (inst.countries?.includes(shock.country)) return true;
  return shock.currency === 'USD' && ['metal', 'energy', 'crypto', 'agri'].includes(s.assetClass);
}

class InstrumentSim {
  readonly spec: InstrumentSpec;
  private readonly rng: Prng;
  private readonly tick;
  private readonly tickF: number;
  private readonly sigmaStep: number;
  private logP: number;
  private anchorLog: number;
  regime: Regime = 'range';
  private trendSign = 1;
  private highVolUntil = -1;
  private shockUntil = -1;
  quoteSeq = 0;
  tradeSeq = 0;
  depthSeq = 0;
  lastQuote: Quote | null = null;
  lastDepth: DepthSnapshot | null = null;

  constructor(
    readonly inst: SimInstrument,
    seed: string | number,
    stepMs: number,
    private readonly depthLevels: number,
    private readonly source: string,
  ) {
    this.spec = inst.spec;
    this.rng = new Prng(`${seed}|${inst.spec.symbol}`);
    this.tick = dec(inst.spec.tickSize);
    this.tickF = Number(inst.spec.tickSize);
    this.sigmaStep = inst.profile.annualVol * Math.sqrt(stepMs / 1000 / YEAR_SECONDS);
    const start = floatToPrice(Number(inst.startPrice ?? inst.profile.refPrice), inst.spec);
    this.logP = Math.log(Number(start.toFixed()));
    this.anchorLog = this.logP;
  }

  step(step: number, ts: number, shocks: EventShock[], stepMs: number): SimOutput {
    const { rng, spec, inst } = this;
    const p = inst.profile;

    // 1. Regime switching (one uniform per step, fixed order).
    const u = rng.next();
    if (this.regime === 'range') {
      if (u < 0.0005) this.regime = 'high_vol';
      else if (u < 0.0025) {
        this.regime = 'trend';
        this.trendSign = rng.next() < 0.5 ? -1 : 1;
      }
    } else if (this.regime === 'trend') {
      if (u < 0.0005) this.regime = 'high_vol';
      else if (u < 0.0035) this.regime = 'range';
    } else if (step >= this.highVolUntil && u < 0.01) {
      this.regime = 'range';
    }

    // 2. Scheduled event shocks.
    let jump = 0;
    for (const s of shocks) {
      if (s.ts > ts - stepMs && s.ts <= ts && isAffected(inst, s)) {
        jump += rng.normal() * this.sigmaStep * SHOCK_JUMP_SIGMAS[s.impact];
        this.highVolUntil = Math.max(this.highVolUntil, step + s.impact * SHOCK_STEPS_PER_IMPACT);
        this.shockUntil = Math.max(this.shockUntil, step + s.impact * 100);
        this.regime = 'high_vol';
      }
    }

    // 3. GBM increment with regime drift / mean reversion.
    const mu = this.regime === 'trend' ? this.trendSign * 0.08 * this.sigmaStep : 0;
    const mr = this.regime === 'range' ? -0.0005 * (this.logP - this.anchorLog) : 0;
    this.logP += mu + mr + VOL_MULT[this.regime] * this.sigmaStep * rng.normal() + jump;
    if (this.regime !== 'range') this.anchorLog += 0.001 * (this.logP - this.anchorLog);
    const mid = Math.exp(this.logP);

    // 4. Spread (ticks), wider in high-vol and just after events.
    const spreadMult = (this.regime === 'high_vol' ? 2 : 1) * (step < this.shockUntil ? 3 : 1);
    const spreadTicks = Math.max(
      1,
      Math.round(p.spreadTicks * spreadMult * (1 + 0.25 * Math.abs(rng.normal()))),
    );
    const bid = floatToPrice(mid - (spreadTicks * this.tickF) / 2, spec, 'down');
    const ask = bid.add(this.tick.mul(spreadTicks));

    // 5. Depth ladder (sizes on the qty grid).
    const baseSize = Number(spec.minQty) * p.depthScale;
    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];
    for (let k = 0; k < this.depthLevels; k++) {
      const bSize = floatToQty(baseSize * (1 + 0.4 * k) * Math.exp(0.5 * rng.normal()), spec);
      const aSize = floatToQty(baseSize * (1 + 0.4 * k) * Math.exp(0.5 * rng.normal()), spec);
      const bPx = bid.sub(this.tick.mul(k));
      if (bPx.gt(0)) bids.push([bPx.toFixed(spec.pricePrecision), bSize]);
      asks.push([ask.add(this.tick.mul(k)).toFixed(spec.pricePrecision), aSize]);
    }

    // 6. Trades (Poisson), aggressor at the touch.
    const trades: Trade[] = [];
    const n = rng.poisson((p.tradeRate * stepMs) / 1000, 8);
    const buyBias = this.regime === 'trend' ? 0.1 * this.trendSign : 0;
    for (let i = 0; i < n; i++) {
      const side = rng.next() < 0.5 + buyBias ? 'buy' : 'sell';
      const qty = floatToQty(baseSize * 0.05 * Math.exp(rng.normal()), spec);
      this.tradeSeq += 1;
      trades.push({
        type: 'trade',
        symbol: spec.symbol,
        tradeId: `${spec.symbol}-${this.tradeSeq}`,
        price: (side === 'buy' ? ask : bid).toFixed(spec.pricePrecision),
        qty,
        side,
        source: this.source,
        exchangeTs: ts,
        receivedTs: ts,
        seq: this.tradeSeq,
      });
    }

    let quote: Quote | null = null;
    let depth: DepthSnapshot | null = null;
    if (step % p.quoteEveryNSteps === 0) {
      this.quoteSeq += 1;
      this.depthSeq += 1;
      quote = {
        type: 'quote',
        symbol: spec.symbol,
        bid: bid.toFixed(spec.pricePrecision),
        ask: ask.toFixed(spec.pricePrecision),
        bidSize: bids[0]?.[1] ?? formatSize('0', spec),
        askSize: asks[0]![1],
        stale: false,
        source: this.source,
        exchangeTs: ts,
        receivedTs: ts,
        seq: this.quoteSeq,
      };
      depth = {
        type: 'depth_snapshot',
        symbol: spec.symbol,
        bids,
        asks,
        source: this.source,
        exchangeTs: ts,
        receivedTs: ts,
        seq: this.depthSeq,
      };
      this.lastQuote = quote;
      this.lastDepth = depth;
    }
    return { symbol: spec.symbol, quote, depth, trades, regime: this.regime };
  }
}

export class SimulatedMarket {
  readonly stepMs: number;
  readonly startTs: number;
  readonly source: string;
  private readonly sims: InstrumentSim[];
  private readonly bySymbol = new Map<string, InstrumentSim>();
  private shocks: EventShock[];
  private stepIndex = 0;

  constructor(opts: SimMarketOptions) {
    this.stepMs = opts.stepMs ?? DEFAULT_STEP_MS;
    this.startTs = opts.startTs;
    this.source = opts.source ?? 'simulated';
    this.shocks = [...(opts.shocks ?? [])].sort((a, b) => a.ts - b.ts);
    const levels = opts.depthLevels ?? DEFAULT_DEPTH_LEVELS;
    this.sims = opts.instruments.map(
      (i) => new InstrumentSim(i, opts.seed, this.stepMs, levels, this.source),
    );
    for (const s of this.sims) this.bySymbol.set(s.spec.symbol, s);
  }

  /** Steps taken so far; the next step's virtual time is startTs + (steps + 1) * stepMs. */
  get steps(): number {
    return this.stepIndex;
  }

  get now(): number {
    return this.startTs + this.stepIndex * this.stepMs;
  }

  symbols(): string[] {
    return this.sims.map((s) => s.spec.symbol);
  }

  addShocks(shocks: EventShock[]): void {
    const known = new Set(this.shocks.map((s) => s.id));
    this.shocks = [...this.shocks, ...shocks.filter((s) => !known.has(s.id))].sort(
      (a, b) => a.ts - b.ts,
    );
  }

  step(): SimStep {
    this.stepIndex += 1;
    const ts = this.now;
    const active = this.shocks.filter((s) => s.ts > ts - this.stepMs && s.ts <= ts);
    return {
      step: this.stepIndex,
      ts,
      outputs: this.sims.map((s) => s.step(this.stepIndex, ts, active, this.stepMs)),
    };
  }

  lastQuote(symbol: string): Quote | null {
    return this.bySymbol.get(symbol)?.lastQuote ?? null;
  }

  lastDepth(symbol: string): DepthSnapshot | null {
    return this.bySymbol.get(symbol)?.lastDepth ?? null;
  }

  regime(symbol: string): Regime | null {
    return this.bySymbol.get(symbol)?.regime ?? null;
  }
}
