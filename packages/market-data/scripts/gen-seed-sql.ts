/**
 * Prints the SIMULATED registry seed as SQL INSERTs from the TypeScript catalog. Used once to write
 * migration 0002; later registry changes need a new migration (the api drift test compares the
 * database with the catalog).
 */
import { SEED_ALIASES, SEED_ASSET_CLASSES, SEED_INSTRUMENTS, SEED_VENUES } from '../src/index.js';

const q = (v: string | null): string => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const j = (v: unknown): string => (v === null ? 'NULL' : `${q(JSON.stringify(v))}::jsonb`);
const b = (v: boolean): string => (v ? 'true' : 'false');

const out: string[] = [];
out.push('INSERT INTO asset_classes (asset_class, label, stale_after_ms) VALUES');
out.push(
  SEED_ASSET_CLASSES.map((a) => `  (${q(a.assetClass)}, ${q(a.label)}, ${a.staleAfterMs})`).join(
    ',\n',
  ) + ';\n',
);
out.push(
  'INSERT INTO venues (mic, iso_mic, operating_mic, name, country, region, timezone, currency, calendar, calendar_source, status, simulated) VALUES',
);
out.push(
  SEED_VENUES.map(
    (v) =>
      `  (${q(v.mic)}, ${b(v.isoMic)}, ${q(v.operatingMic)}, ${q(v.name)}, ${q(v.country)}, ${q(v.region)}, ${q(v.timezone)}, ${q(v.currency)}, ${j(v.calendar)}, ${q(v.calendarSource)}, ${q(v.status)}, ${b(v.simulated)})`,
  ).join(',\n') + ';\n',
);
out.push(
  'INSERT INTO instruments (symbol, display_name, venue, venue_symbol, isin, figi, asset_class, underlying_class, base_ccy, quote_ccy, tick_size, price_precision, pip_size, contract_size, min_qty, qty_step, qty_precision, trading_sessions, margin_rates, fee_schedule_id, status, simulated) VALUES',
);
out.push(
  SEED_INSTRUMENTS.map(
    (i) =>
      `  (${q(i.symbol)}, ${q(i.displayName)}, ${q(i.venue)}, ${q(i.venueSymbol)}, ${q(i.isin)}, ${q(i.figi)}, ${q(i.assetClass)}, ${q(i.underlyingClass)}, ${q(i.baseCcy)}, ${q(i.quoteCcy)}, ${i.tickSize}, ${i.pricePrecision}, ${i.pipSize ?? 'NULL'}, ${i.contractSize}, ${i.minQty}, ${i.qtyStep}, ${i.qtyPrecision}, ${j(i.tradingSessions)}, ${j(i.marginRates)}, ${q(i.feeScheduleId)}, ${q(i.status)}, ${b(i.simulated)})`,
  ).join(',\n') + ';\n',
);
out.push('INSERT INTO instrument_aliases (source, vendor_symbol, symbol) VALUES');
out.push(
  SEED_ALIASES.map((a) => `  (${q(a.source)}, ${q(a.vendorSymbol)}, ${q(a.symbol)})`).join(',\n') +
    ';',
);
console.log(out.join('\n'));
