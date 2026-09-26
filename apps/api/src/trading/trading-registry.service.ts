import { Injectable, NotFoundException } from '@nestjs/common';
import {
  dec,
  priceMultiplier,
  type AssetClassTrading,
  type Decimal,
  type FeeSchedule,
  type InstrumentSpec,
  type MultiplierMode,
  type Venue,
} from '@kora/domain';

import { DbService } from '../db/db.service';
import { InstrumentsRepository } from '../market-data/instruments.repository';

export interface TradableInstrument {
  spec: InstrumentSpec;
  venue: Venue;
  fees: FeeSchedule;
  trading: AssetClassTrading;
  multiplier: Decimal;
  staleAfterMs: number;
}

interface FeeRow {
  id: string;
  commission_bps: string;
  commission_per_unit: string;
  commission_min: string;
  swap_long_bps: string;
  swap_short_bps: string;
  fx_conversion_bps: string;
  simulated: boolean;
}

interface ClassRow {
  asset_class: AssetClassTrading['assetClass'];
  multiplier_mode: MultiplierMode;
  fat_finger_pct: string;
  impact_ticks: string;
  vol_factor: string;
  max_levels: number;
  simulated: boolean;
}

/**
 * Registry view for the trading core: instrument spec + venue + fee schedule + asset-class
 * execution parameters (all registry rows; SIMULATED placeholders flagged `simulated`).
 */
@Injectable()
export class TradingRegistryService {
  private cache: {
    fees: Map<string, FeeSchedule>;
    classes: Map<string, AssetClassTrading>;
    at: number;
  } | null = null;

  constructor(
    private readonly db: DbService,
    private readonly instruments: InstrumentsRepository,
  ) {}

  private async tables(): Promise<{
    fees: Map<string, FeeSchedule>;
    classes: Map<string, AssetClassTrading>;
  }> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache;
    const [fees, classes] = await Promise.all([
      this.db.query<FeeRow>('SELECT * FROM fee_schedules'),
      this.db.query<ClassRow>('SELECT * FROM asset_class_trading'),
    ]);
    this.cache = {
      fees: new Map(
        fees.map((f) => [
          f.id,
          {
            id: f.id,
            commissionBps: f.commission_bps,
            commissionPerUnit: f.commission_per_unit,
            commissionMin: f.commission_min,
            swapLongBps: f.swap_long_bps,
            swapShortBps: f.swap_short_bps,
            fxConversionBps: f.fx_conversion_bps,
            simulated: f.simulated,
          },
        ]),
      ),
      classes: new Map(
        classes.map((c) => [
          c.asset_class,
          {
            assetClass: c.asset_class,
            multiplierMode: c.multiplier_mode,
            fatFingerPct: c.fat_finger_pct,
            impactTicks: c.impact_ticks,
            volFactor: c.vol_factor,
            maxLevels: c.max_levels,
            simulated: c.simulated,
          },
        ]),
      ),
      at: Date.now(),
    };
    return this.cache;
  }

  async get(symbol: string): Promise<TradableInstrument> {
    const found = await this.find(symbol);
    if (!found)
      throw new NotFoundException({
        error: 'unknown_symbol',
        message: `Unknown instrument ${symbol}`,
      });
    return found;
  }

  async find(symbol: string): Promise<TradableInstrument | null> {
    const reg = await this.instruments.load();
    const spec = reg.instruments.get(symbol);
    if (!spec) return null;
    const venue = reg.venues.get(spec.venue);
    const { fees, classes } = await this.tables();
    const fs = fees.get(spec.feeScheduleId);
    const trading = classes.get(spec.assetClass);
    if (!venue || !fs || !trading) throw new Error(`registry incomplete for ${symbol}`);
    return {
      spec,
      venue,
      fees: fs,
      trading,
      multiplier: priceMultiplier(spec, trading.multiplierMode),
      staleAfterMs: reg.staleAfterMs.get(spec.assetClass) ?? 5000,
    };
  }

  /** Margin rate for a tier; unknown tiers fall back to the most conservative (highest) rate. */
  marginRate(spec: InstrumentSpec, tier: string): Decimal {
    const r = spec.marginRates[tier];
    if (r) return dec(r);
    const all = Object.values(spec.marginRates).map((v) => dec(v));
    return all.length ? all.reduce((a, b) => (a.gt(b) ? a : b)) : dec('1');
  }

  /** FX instruments by (base, quote) for the FX service. */
  async fxPairs(): Promise<Map<string, InstrumentSpec>> {
    const reg = await this.instruments.load();
    const out = new Map<string, InstrumentSpec>();
    for (const s of reg.instruments.values()) {
      if (s.assetClass === 'fx' && s.baseCcy && s.status === 'active')
        out.set(`${s.baseCcy}/${s.quoteCcy}`, s);
    }
    return out;
  }
}
