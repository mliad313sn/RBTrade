import { Injectable } from '@nestjs/common';
import type { AssetClass, InstrumentSessions, InstrumentSpec, Region, SessionCalendar, Venue } from '@kora/domain';

import { DbService } from '../db/db.service';

interface InstrumentRow {
  symbol: string;
  display_name: string;
  venue: string;
  venue_symbol: string | null;
  isin: string | null;
  figi: string | null;
  asset_class: AssetClass;
  underlying_class: AssetClass | null;
  base_ccy: string | null;
  quote_ccy: string;
  price_unit?: string | null;
  price_unit_factor?: string | null;
  tick_size: string;
  price_precision: number;
  pip_size: string | null;
  contract_size: string;
  min_qty: string;
  qty_step: string;
  qty_precision: number;
  trading_sessions: InstrumentSessions | null;
  margin_rates: Record<string, string>;
  fee_schedule_id: string;
  status: InstrumentSpec['status'];
  simulated: boolean;
}

interface VenueRow {
  mic: string;
  iso_mic: boolean;
  operating_mic: string | null;
  name: string;
  country: string;
  region: Region;
  timezone: string;
  currency: string;
  calendar: SessionCalendar;
  calendar_source: string;
  status: Venue['status'];
  simulated: boolean;
}

export interface Registry {
  instruments: Map<string, InstrumentSpec>;
  venues: Map<string, Venue>;
  staleAfterMs: Map<AssetClass, number>;
  aliases: Array<{ source: string; vendorSymbol: string; symbol: string }>;
  loadedAt: number;
}

const toSpec = (r: InstrumentRow): InstrumentSpec => ({
  symbol: r.symbol,
  displayName: r.display_name,
  venue: r.venue,
  venueSymbol: r.venue_symbol,
  isin: r.isin,
  figi: r.figi,
  assetClass: r.asset_class,
  underlyingClass: r.underlying_class,
  baseCcy: r.base_ccy,
  quoteCcy: r.quote_ccy,
  ...(r.price_unit ? { priceUnit: r.price_unit, priceUnitFactor: r.price_unit_factor ?? null } : {}),
  tickSize: r.tick_size,
  pricePrecision: r.price_precision,
  pipSize: r.pip_size,
  contractSize: r.contract_size,
  minQty: r.min_qty,
  qtyStep: r.qty_step,
  qtyPrecision: r.qty_precision,
  tradingSessions: r.trading_sessions,
  marginRates: r.margin_rates,
  feeScheduleId: r.fee_schedule_id,
  status: r.status,
  simulated: r.simulated,
});

const toVenue = (r: VenueRow): Venue => ({
  mic: r.mic,
  isoMic: r.iso_mic,
  operatingMic: r.operating_mic,
  name: r.name,
  country: r.country,
  region: r.region,
  timezone: r.timezone,
  currency: r.currency,
  calendar: r.calendar,
  calendarSource: r.calendar_source,
  status: r.status,
  simulated: r.simulated,
});

/** The instrument registry: the only source of precision, tick and session data (goal 02). */
@Injectable()
export class InstrumentsRepository {
  private cache: Registry | null = null;

  constructor(private readonly db: DbService) {}

  async load(maxAgeMs = 60_000): Promise<Registry> {
    if (this.cache && Date.now() - this.cache.loadedAt < maxAgeMs) return this.cache;
    const [inst, venues, classes, aliases] = await Promise.all([
      this.db.query<InstrumentRow>('SELECT * FROM instruments ORDER BY symbol'),
      this.db.query<VenueRow>('SELECT * FROM venues ORDER BY mic'),
      this.db.query<{ asset_class: AssetClass; stale_after_ms: number }>('SELECT asset_class, stale_after_ms FROM asset_classes'),
      this.db.query<{ source: string; vendor_symbol: string; symbol: string }>('SELECT source, vendor_symbol, symbol FROM instrument_aliases'),
    ]);
    this.cache = {
      instruments: new Map(inst.map((r) => [r.symbol, toSpec(r)])),
      venues: new Map(venues.map((r) => [r.mic, toVenue(r)])),
      staleAfterMs: new Map(classes.map((c) => [c.asset_class, c.stale_after_ms])),
      aliases: aliases.map((a) => ({ source: a.source, vendorSymbol: a.vendor_symbol, symbol: a.symbol })),
      loadedAt: Date.now(),
    };
    return this.cache;
  }

  /** Last known price per symbol (live 1 s bars first, then history) for continuous restarts. */
  async lastCloses(): Promise<Map<string, string>> {
    const rows = await this.db.query<{ symbol: string; close: string }>(
      `SELECT DISTINCT ON (symbol) symbol, close FROM (
         SELECT symbol, ts, close FROM (SELECT DISTINCT ON (symbol) symbol, ts, close FROM md_bars_1s ORDER BY symbol, ts DESC) a
         UNION ALL
         SELECT symbol, bucket, close FROM (SELECT DISTINCT ON (symbol) symbol, bucket, close FROM md_candles_history WHERE tf = '1m' ORDER BY symbol, bucket DESC) b
       ) u ORDER BY symbol, ts DESC`,
    );
    return new Map(rows.map((r) => [r.symbol, r.close]));
  }
}
