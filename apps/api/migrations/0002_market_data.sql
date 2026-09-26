-- 0002 market data (goal 02, ADR 0002): global venue/instrument registry, trades, 1 s bars and
-- candle rollups. Runs as kora_owner. Plain Postgres; TimescaleDB objects only if the extension
-- exists. All seed rows are SIMULATED (generated from packages/market-data/src/seed by
-- `pnpm --filter @kora/market-data gen:seed-sql`).

-- ---------------------------------------------------------------------------
-- Registry
-- ---------------------------------------------------------------------------
CREATE TABLE asset_classes (
  asset_class text PRIMARY KEY CHECK (asset_class ~ '^[a-z_]+$'),
  label text NOT NULL,
  stale_after_ms integer NOT NULL CHECK (stale_after_ms > 0)
);

CREATE TABLE venues (
  mic text PRIMARY KEY CHECK (mic ~ '^[A-Z0-9]{4}$'),
  iso_mic boolean NOT NULL,                          -- false for KORA's simulated OTC venues
  operating_mic text CHECK (operating_mic ~ '^[A-Z0-9]{4}$'),
  name text NOT NULL,
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),                  -- ISO 3166-1 alpha-2
  region text NOT NULL CHECK (region IN ('africa', 'asia', 'europe', 'north_america', 'south_america', 'oceania', 'global')),
  timezone text NOT NULL,                            -- IANA, validated by trigger
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),                -- ISO 4217
  calendar jsonb NOT NULL CHECK (jsonb_typeof(calendar) = 'object' AND calendar ? 'weekly'),
  calendar_source text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  simulated boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION md_assert_timezone(tz text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF tz IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz) THEN
    RAISE EXCEPTION 'unknown IANA timezone %', tz USING ERRCODE = '22023';
  END IF;
END $$;

CREATE FUNCTION venues_check_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM md_assert_timezone(NEW.timezone);
  RETURN NEW;
END $$;

CREATE TRIGGER venues_timezone_check BEFORE INSERT OR UPDATE ON venues
  FOR EACH ROW EXECUTE FUNCTION venues_check_timezone();

CREATE TABLE instruments (
  symbol text PRIMARY KEY CHECK (symbol ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
  display_name text NOT NULL,
  venue text NOT NULL REFERENCES venues (mic),
  venue_symbol text,
  isin text CHECK (isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  figi text CHECK (figi ~ '^[B-DF-HJ-NP-TV-Z]{2}G[B-DF-HJ-NP-TV-Z0-9]{8}[0-9]$'),
  asset_class text NOT NULL REFERENCES asset_classes (asset_class),
  underlying_class text REFERENCES asset_classes (asset_class),
  base_ccy text CHECK (base_ccy ~ '^[A-Z0-9]{3,5}$'),
  quote_ccy text NOT NULL CHECK (quote_ccy ~ '^[A-Z]{3}$'),
  tick_size numeric NOT NULL CHECK (tick_size > 0),
  price_precision smallint NOT NULL CHECK (price_precision BETWEEN 0 AND 12),
  pip_size numeric CHECK (pip_size > 0),
  contract_size numeric NOT NULL CHECK (contract_size > 0),
  min_qty numeric NOT NULL CHECK (min_qty > 0),
  qty_step numeric NOT NULL CHECK (qty_step > 0),
  qty_precision smallint NOT NULL CHECK (qty_precision BETWEEN 0 AND 12),
  trading_sessions jsonb CHECK (trading_sessions IS NULL OR (trading_sessions ? 'timezone' AND trading_sessions ? 'weekly')),
  margin_rates jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(margin_rates) = 'object'), -- SIMULATED placeholders (OQ-M1)
  fee_schedule_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'halted', 'delisted')),
  simulated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instruments_tick_fits_precision CHECK (scale(trim_scale(tick_size)) <= price_precision),
  CONSTRAINT instruments_step_fits_precision CHECK (scale(trim_scale(qty_step)) <= qty_precision),
  CONSTRAINT instruments_min_on_step CHECK (min_qty >= qty_step)
);
CREATE INDEX instruments_venue_idx ON instruments (venue);
CREATE INDEX instruments_asset_class_idx ON instruments (asset_class);
CREATE UNIQUE INDEX instruments_isin_venue_uq ON instruments (isin, venue) WHERE isin IS NOT NULL;
CREATE UNIQUE INDEX instruments_venue_symbol_uq ON instruments (venue, venue_symbol) WHERE venue_symbol IS NOT NULL;

CREATE FUNCTION instruments_check_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM md_assert_timezone(NEW.trading_sessions ->> 'timezone');
  RETURN NEW;
END $$;

CREATE TRIGGER instruments_timezone_check BEFORE INSERT OR UPDATE ON instruments
  FOR EACH ROW EXECUTE FUNCTION instruments_check_timezone();

-- Vendor symbol → internal symbol, per data source.
CREATE TABLE instrument_aliases (
  source text NOT NULL CHECK (source ~ '^[a-z0-9-]{1,64}$'),
  vendor_symbol text NOT NULL CHECK (char_length(vendor_symbol) BETWEEN 1 AND 64),
  symbol text NOT NULL REFERENCES instruments (symbol) ON DELETE CASCADE,
  PRIMARY KEY (source, vendor_symbol)
);

-- ---------------------------------------------------------------------------
-- Time series. No FK to instruments on the hot tables (ingest speed; hypertables).
-- ---------------------------------------------------------------------------
CREATE TABLE md_trades (
  symbol text NOT NULL,
  ts timestamptz NOT NULL,
  source text NOT NULL,
  trade_id text NOT NULL,
  seq bigint NOT NULL,
  price numeric NOT NULL CHECK (price > 0),
  qty numeric NOT NULL CHECK (qty > 0),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (symbol, ts, source, trade_id)
);

CREATE TABLE md_bars_1s (
  symbol text NOT NULL,
  ts timestamptz NOT NULL,
  open numeric NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  close numeric NOT NULL,
  volume numeric NOT NULL CHECK (volume >= 0),
  trades integer NOT NULL CHECK (trades >= 0),
  PRIMARY KEY (symbol, ts),
  CONSTRAINT md_bars_1s_ohlc CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close)
);

-- Continuous-aggregate emulation: derived only from md_bars_1s by md_refresh_candles().
CREATE TABLE md_candles (
  symbol text NOT NULL,
  tf text NOT NULL CHECK (tf IN ('1m', '5m', '15m', '1h', '4h', '1D')),
  bucket timestamptz NOT NULL,
  open numeric NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  close numeric NOT NULL,
  volume numeric NOT NULL,
  trades integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, tf, bucket)
);

-- SIMULATED backfill before the first live bar (merged per bucket by the candles query).
CREATE TABLE md_candles_history (
  symbol text NOT NULL,
  tf text NOT NULL CHECK (tf IN ('1m', '5m', '15m', '1h', '4h', '1D')),
  bucket timestamptz NOT NULL,
  open numeric NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  close numeric NOT NULL,
  volume numeric NOT NULL,
  trades integer NOT NULL,
  source text NOT NULL,
  PRIMARY KEY (symbol, tf, bucket)
);

-- Hierarchical rollup 1s → 1m → 5m → 15m → 1h → 4h → 1D for every bucket touched since p_from.
-- Buckets are UTC-aligned (date_bin origin 2000-01-01T00:00Z). Idempotent.
CREATE FUNCTION md_refresh_candles(p_from timestamptz) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  origin constant timestamptz := timestamptz '2000-01-01 00:00:00+00';
  r record;
  c integer;
  total integer := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      (1, '1m', '1s', interval '1 minute'),
      (2, '5m', '1m', interval '5 minutes'),
      (3, '15m', '5m', interval '15 minutes'),
      (4, '1h', '15m', interval '1 hour'),
      (5, '4h', '1h', interval '4 hours'),
      (6, '1D', '4h', interval '1 day')) AS v(ord, tf, src, width)
    ORDER BY ord
  LOOP
    INSERT INTO md_candles AS m (symbol, tf, bucket, open, high, low, close, volume, trades, updated_at)
    SELECT s.symbol, r.tf, date_bin(r.width, s.ts, origin) AS b,
           (array_agg(s.open ORDER BY s.ts))[1], max(s.high), min(s.low),
           (array_agg(s.close ORDER BY s.ts DESC))[1], sum(s.volume), sum(s.trades)::integer, now()
    FROM (
      SELECT symbol, ts, open, high, low, close, volume, trades FROM md_bars_1s
        WHERE r.src = '1s' AND ts >= date_bin(r.width, p_from, origin)
      UNION ALL
      SELECT symbol, bucket, open, high, low, close, volume, trades FROM md_candles
        WHERE r.src <> '1s' AND tf = r.src AND bucket >= date_bin(r.width, p_from, origin)
    ) AS s
    GROUP BY s.symbol, b
    ON CONFLICT (symbol, tf, bucket) DO UPDATE
      SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
          volume = EXCLUDED.volume, trades = EXCLUDED.trades, updated_at = EXCLUDED.updated_at
      WHERE (m.open, m.high, m.low, m.close, m.volume, m.trades)
        IS DISTINCT FROM (EXCLUDED.open, EXCLUDED.high, EXCLUDED.low, EXCLUDED.close, EXCLUDED.volume, EXCLUDED.trades);
    GET DIAGNOSTICS c = ROW_COUNT;
    total := total + c;
  END LOOP;
  RETURN total;
END $$;

-- Retention (called hourly by the feed; Timescale policies replace it where available).
CREATE FUNCTION md_apply_retention(p_now timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t integer; b integer; c integer;
BEGIN
  DELETE FROM md_trades WHERE ts < p_now - interval '7 days';
  GET DIAGNOSTICS t = ROW_COUNT;
  DELETE FROM md_bars_1s WHERE ts < p_now - interval '7 days';
  GET DIAGNOSTICS b = ROW_COUNT;
  DELETE FROM md_candles WHERE tf = '1m' AND bucket < p_now - interval '90 days';
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN jsonb_build_object('trades', t, 'bars_1s', b, 'candles_1m', c);
END $$;

-- TimescaleDB (deployment reference; not present in the build environment).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_extension WHERE extname = 'timescaledb') THEN
    EXECUTE $q$SELECT create_hypertable('md_trades', 'ts', chunk_time_interval => interval '1 day', migrate_data => true)$q$;
    EXECUTE $q$SELECT create_hypertable('md_bars_1s', 'ts', chunk_time_interval => interval '1 day', migrate_data => true)$q$;
    EXECUTE $q$SELECT add_retention_policy('md_trades', interval '7 days')$q$;
    EXECUTE $q$SELECT add_retention_policy('md_bars_1s', interval '7 days')$q$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT SELECT ON asset_classes, venues, instruments, instrument_aliases TO kora_app, kora_audit_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON md_trades, md_bars_1s, md_candles, md_candles_history TO kora_app;
GRANT SELECT ON md_trades, md_bars_1s, md_candles, md_candles_history TO kora_audit_reader;
REVOKE ALL ON FUNCTION md_refresh_candles(timestamptz), md_apply_retention(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION md_refresh_candles(timestamptz), md_apply_retention(timestamptz) TO kora_app;

-- ---------------------------------------------------------------------------
-- SIMULATED seed (generated)
-- ---------------------------------------------------------------------------
INSERT INTO asset_classes (asset_class, label, stale_after_ms) VALUES
  ('fx', 'FX', 2000),
  ('metal', 'Metal', 2000),
  ('crypto', 'Crypto', 2000),
  ('equity', 'Equity', 5000),
  ('etf', 'ETF', 5000),
  ('bond', 'Bond', 5000),
  ('future', 'Future', 5000),
  ('option', 'Option', 5000),
  ('energy', 'Energy', 5000),
  ('agri', 'Agri', 5000),
  ('index', 'Index', 5000),
  ('cfd', 'CFD', 5000),
  ('fund', 'Fund', 3600000);

INSERT INTO venues (mic, iso_mic, operating_mic, name, country, region, timezone, currency, calendar, calendar_source, status, simulated) VALUES
  ('XNYS', true, 'XNYS', 'New York Stock Exchange', 'US', 'north_america', 'America/New_York', 'USD', '{"weekly":{"mon":[["09:30","16:00"]],"tue":[["09:30","16:00"]],"wed":[["09:30","16:00"]],"thu":[["09:30","16:00"]],"fri":[["09:30","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-01-19","name":"Martin Luther King Jr. Day"},{"date":"2026-02-16","name":"Washington''s Birthday"},{"date":"2026-04-03","name":"Good Friday"},{"date":"2026-05-25","name":"Memorial Day"},{"date":"2026-06-19","name":"Juneteenth"},{"date":"2026-07-03","name":"Independence Day (observed)"},{"date":"2026-09-07","name":"Labor Day"},{"date":"2026-11-26","name":"Thanksgiving Day"},{"date":"2026-12-25","name":"Christmas Day"}],"earlyCloses":[{"date":"2026-11-27","close":"13:00","name":"Day after Thanksgiving"},{"date":"2026-12-24","close":"13:00","name":"Christmas Eve"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XNAS', true, 'XNAS', 'Nasdaq', 'US', 'north_america', 'America/New_York', 'USD', '{"weekly":{"mon":[["09:30","16:00"]],"tue":[["09:30","16:00"]],"wed":[["09:30","16:00"]],"thu":[["09:30","16:00"]],"fri":[["09:30","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-01-19","name":"Martin Luther King Jr. Day"},{"date":"2026-02-16","name":"Washington''s Birthday"},{"date":"2026-04-03","name":"Good Friday"},{"date":"2026-05-25","name":"Memorial Day"},{"date":"2026-06-19","name":"Juneteenth"},{"date":"2026-07-03","name":"Independence Day (observed)"},{"date":"2026-09-07","name":"Labor Day"},{"date":"2026-11-26","name":"Thanksgiving Day"},{"date":"2026-12-25","name":"Christmas Day"}],"earlyCloses":[{"date":"2026-11-27","close":"13:00","name":"Day after Thanksgiving"},{"date":"2026-12-24","close":"13:00","name":"Christmas Eve"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('ARCX', true, 'XNYS', 'NYSE Arca', 'US', 'north_america', 'America/New_York', 'USD', '{"weekly":{"mon":[["09:30","16:00"]],"tue":[["09:30","16:00"]],"wed":[["09:30","16:00"]],"thu":[["09:30","16:00"]],"fri":[["09:30","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-01-19","name":"Martin Luther King Jr. Day"},{"date":"2026-02-16","name":"Washington''s Birthday"},{"date":"2026-04-03","name":"Good Friday"},{"date":"2026-05-25","name":"Memorial Day"},{"date":"2026-06-19","name":"Juneteenth"},{"date":"2026-07-03","name":"Independence Day (observed)"},{"date":"2026-09-07","name":"Labor Day"},{"date":"2026-11-26","name":"Thanksgiving Day"},{"date":"2026-12-25","name":"Christmas Day"}],"earlyCloses":[{"date":"2026-11-27","close":"13:00","name":"Day after Thanksgiving"},{"date":"2026-12-24","close":"13:00","name":"Christmas Eve"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XCBO', true, 'XCBO', 'Cboe Options Exchange', 'US', 'north_america', 'America/Chicago', 'USD', '{"weekly":{"mon":[["08:30","15:00"]],"tue":[["08:30","15:00"]],"wed":[["08:30","15:00"]],"thu":[["08:30","15:00"]],"fri":[["08:30","15:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-01-19","name":"Martin Luther King Jr. Day"},{"date":"2026-02-16","name":"Washington''s Birthday"},{"date":"2026-04-03","name":"Good Friday"},{"date":"2026-05-25","name":"Memorial Day"},{"date":"2026-06-19","name":"Juneteenth"},{"date":"2026-07-03","name":"Independence Day (observed)"},{"date":"2026-09-07","name":"Labor Day"},{"date":"2026-11-26","name":"Thanksgiving Day"},{"date":"2026-12-25","name":"Christmas Day"}],"earlyCloses":[]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XCME', true, 'XCME', 'Chicago Mercantile Exchange', 'US', 'north_america', 'America/Chicago', 'USD', '{"weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","16:00"],["17:00","24:00"]],"tue":[["00:00","16:00"],["17:00","24:00"]],"wed":[["00:00","16:00"],["17:00","24:00"]],"thu":[["00:00","16:00"],["17:00","24:00"]],"fri":[["00:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XTSE', true, 'XTSE', 'Toronto Stock Exchange', 'CA', 'north_america', 'America/Toronto', 'CAD', '{"weekly":{"mon":[["09:30","16:00"]],"tue":[["09:30","16:00"]],"wed":[["09:30","16:00"]],"thu":[["09:30","16:00"]],"fri":[["09:30","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-07-01","name":"Canada Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('BVMF', true, 'BVMF', 'B3 (Brasil Bolsa Balcão)', 'BR', 'south_america', 'America/Sao_Paulo', 'BRL', '{"weekly":{"mon":[["10:00","17:00"]],"tue":[["10:00","17:00"]],"wed":[["10:00","17:00"]],"thu":[["10:00","17:00"]],"fri":[["10:00","17:00"]]},"holidays":[{"date":"2026-01-01","name":"Confraternização Universal"},{"date":"2026-12-25","name":"Natal"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XLON', true, 'XLON', 'London Stock Exchange', 'GB', 'europe', 'Europe/London', 'GBP', '{"weekly":{"mon":[["08:00","16:30"]],"tue":[["08:00","16:30"]],"wed":[["08:00","16:30"]],"thu":[["08:00","16:30"]],"fri":[["08:00","16:30"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-04-03","name":"Good Friday"},{"date":"2026-04-06","name":"Easter Monday"},{"date":"2026-05-04","name":"Early May bank holiday"},{"date":"2026-05-25","name":"Spring bank holiday"},{"date":"2026-08-31","name":"Summer bank holiday"},{"date":"2026-12-25","name":"Christmas Day"},{"date":"2026-12-28","name":"Boxing Day (substitute)"}],"earlyCloses":[{"date":"2026-12-24","close":"12:30"},{"date":"2026-12-31","close":"12:30"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XETR', true, 'XFRA', 'Xetra', 'DE', 'europe', 'Europe/Berlin', 'EUR', '{"weekly":{"mon":[["09:00","17:30"]],"tue":[["09:00","17:30"]],"wed":[["09:00","17:30"]],"thu":[["09:00","17:30"]],"fri":[["09:00","17:30"]]},"holidays":[{"date":"2026-01-01","name":"Neujahr"},{"date":"2026-04-03","name":"Karfreitag"},{"date":"2026-04-06","name":"Ostermontag"},{"date":"2026-05-01","name":"Tag der Arbeit"},{"date":"2026-12-24","name":"Heiligabend"},{"date":"2026-12-25","name":"Weihnachten"},{"date":"2026-12-31","name":"Silvester"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XPAR', true, 'XPAR', 'Euronext Paris', 'FR', 'europe', 'Europe/Paris', 'EUR', '{"weekly":{"mon":[["09:00","17:30"]],"tue":[["09:00","17:30"]],"wed":[["09:00","17:30"]],"thu":[["09:00","17:30"]],"fri":[["09:00","17:30"]]},"holidays":[{"date":"2026-01-01","name":"Jour de l''an"},{"date":"2026-04-03","name":"Vendredi saint"},{"date":"2026-04-06","name":"Lundi de Pâques"},{"date":"2026-05-01","name":"Fête du Travail"},{"date":"2026-12-25","name":"Noël"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XTKS', true, 'XJPX', 'Tokyo Stock Exchange', 'JP', 'asia', 'Asia/Tokyo', 'JPY', '{"weekly":{"mon":[["09:00","11:30"],["12:30","15:30"]],"tue":[["09:00","11:30"],["12:30","15:30"]],"wed":[["09:00","11:30"],["12:30","15:30"]],"thu":[["09:00","11:30"],["12:30","15:30"]],"fri":[["09:00","11:30"],["12:30","15:30"]]},"holidays":[{"date":"2026-01-01","name":"New Year"},{"date":"2026-01-02","name":"Market holiday"},{"date":"2026-12-31","name":"Market holiday"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XHKG', true, 'XHKG', 'Hong Kong Exchanges and Clearing', 'HK', 'asia', 'Asia/Hong_Kong', 'HKD', '{"weekly":{"mon":[["09:30","12:00"],["13:00","16:00"]],"tue":[["09:30","12:00"],["13:00","16:00"]],"wed":[["09:30","12:00"],["13:00","16:00"]],"thu":[["09:30","12:00"],["13:00","16:00"]],"fri":[["09:30","12:00"],["13:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XSHG', true, 'XSHG', 'Shanghai Stock Exchange', 'CN', 'asia', 'Asia/Shanghai', 'CNY', '{"weekly":{"mon":[["09:30","11:30"],["13:00","15:00"]],"tue":[["09:30","11:30"],["13:00","15:00"]],"wed":[["09:30","11:30"],["13:00","15:00"]],"thu":[["09:30","11:30"],["13:00","15:00"]],"fri":[["09:30","11:30"],["13:00","15:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XNSE', true, 'XNSE', 'National Stock Exchange of India', 'IN', 'asia', 'Asia/Kolkata', 'INR', '{"weekly":{"mon":[["09:15","15:30"]],"tue":[["09:15","15:30"]],"wed":[["09:15","15:30"]],"thu":[["09:15","15:30"]],"fri":[["09:15","15:30"]]},"holidays":[{"date":"2026-01-26","name":"Republic Day"},{"date":"2026-10-02","name":"Gandhi Jayanti"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XJSE', true, 'XJSE', 'Johannesburg Stock Exchange', 'ZA', 'africa', 'Africa/Johannesburg', 'ZAR', '{"weekly":{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-04-03","name":"Good Friday"},{"date":"2026-04-06","name":"Family Day"},{"date":"2026-04-27","name":"Freedom Day"},{"date":"2026-12-16","name":"Day of Reconciliation"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XASX', true, 'XASX', 'Australian Securities Exchange', 'AU', 'oceania', 'Australia/Sydney', 'AUD', '{"weekly":{"mon":[["10:00","16:00"]],"tue":[["10:00","16:00"]],"wed":[["10:00","16:00"]],"thu":[["10:00","16:00"]],"fri":[["10:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-01-26","name":"Australia Day"},{"date":"2026-04-03","name":"Good Friday"},{"date":"2026-04-06","name":"Easter Monday"},{"date":"2026-12-25","name":"Christmas Day"},{"date":"2026-12-28","name":"Boxing Day (substitute)"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('XNZE', true, 'XNZE', 'New Zealand Exchange', 'NZ', 'oceania', 'Pacific/Auckland', 'NZD', '{"weekly":{"mon":[["10:00","16:45"]],"tue":[["10:00","16:45"]],"wed":[["10:00","16:45"]],"thu":[["10:00","16:45"]],"fri":[["10:00","16:45"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-02-06","name":"Waitangi Day"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('KSIM', false, NULL, 'KORA Simulated OTC (FX, CFD, bonds, funds)', 'US', 'global', 'America/New_York', 'USD', '{"weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","24:00"]],"tue":[["00:00","24:00"]],"wed":[["00:00","24:00"]],"thu":[["00:00","24:00"]],"fri":[["00:00","17:00"]]},"holidays":[{"date":"2026-12-25","name":"Christmas Day"},{"date":"2026-01-01","name":"New Year''s Day"}]}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true),
  ('KCRY', false, NULL, 'KORA Simulated Crypto', 'US', 'global', 'UTC', 'USD', '{"weekly":{"sun":[["00:00","24:00"]],"mon":[["00:00","24:00"]],"tue":[["00:00","24:00"]],"wed":[["00:00","24:00"]],"thu":[["00:00","24:00"]],"fri":[["00:00","24:00"]],"sat":[["00:00","24:00"]]}}'::jsonb, 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2', 'active', true);

INSERT INTO instruments (symbol, display_name, venue, venue_symbol, isin, figi, asset_class, underlying_class, base_ccy, quote_ccy, tick_size, price_precision, pip_size, contract_size, min_qty, qty_step, qty_precision, trading_sessions, margin_rates, fee_schedule_id, status, simulated) VALUES
  ('EURUSD', 'EUR/USD', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'EUR', 'USD', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.0333","professional":"0.005"}'::jsonb, 'sim-fx', 'active', true),
  ('GBPUSD', 'GBP/USD', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'GBP', 'USD', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.0333","professional":"0.005"}'::jsonb, 'sim-fx', 'active', true),
  ('USDJPY', 'USD/JPY', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'USD', 'JPY', 0.001, 3, 0.01, 100000, 1000, 1000, 0, NULL, '{"retail":"0.0333","professional":"0.005"}'::jsonb, 'sim-fx', 'active', true),
  ('USDCHF', 'USD/CHF', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'USD', 'CHF', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.0333","professional":"0.005"}'::jsonb, 'sim-fx', 'active', true),
  ('AUDUSD', 'AUD/USD', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'AUD', 'USD', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.0333","professional":"0.005"}'::jsonb, 'sim-fx', 'active', true),
  ('USDCAD', 'USD/CAD', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'USD', 'CAD', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.0333","professional":"0.005"}'::jsonb, 'sim-fx', 'active', true),
  ('NZDUSD', 'NZD/USD', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'NZD', 'USD', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true),
  ('EURGBP', 'EUR/GBP', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'EUR', 'GBP', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true),
  ('EURJPY', 'EUR/JPY', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'EUR', 'JPY', 0.001, 3, 0.01, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true),
  ('GBPJPY', 'GBP/JPY', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'GBP', 'JPY', 0.001, 3, 0.01, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true),
  ('XAUUSD', 'XAU/USD', 'KSIM', NULL, NULL, NULL, 'metal', NULL, 'XAU', 'USD', 0.01, 2, 0.1, 100, 1, 1, 0, NULL, '{"retail":"0.05","professional":"0.02"}'::jsonb, 'sim-metal', 'active', true),
  ('XAGUSD', 'XAG/USD', 'KSIM', NULL, NULL, NULL, 'metal', NULL, 'XAG', 'USD', 0.001, 3, 0.01, 5000, 10, 10, 0, NULL, '{"retail":"0.10","professional":"0.02"}'::jsonb, 'sim-metal', 'active', true),
  ('BTCUSD', 'BTC/USD', 'KCRY', NULL, NULL, NULL, 'crypto', NULL, 'BTC', 'USD', 0.1, 1, NULL, 1, 0.0001, 0.0001, 4, NULL, '{"retail":"0.50","professional":"0.20"}'::jsonb, 'sim-crypto', 'active', true),
  ('ETHUSD', 'ETH/USD', 'KCRY', NULL, NULL, NULL, 'crypto', NULL, 'ETH', 'USD', 0.01, 2, NULL, 1, 0.001, 0.001, 3, NULL, '{"retail":"0.50","professional":"0.20"}'::jsonb, 'sim-crypto', 'active', true),
  ('SOLUSD', 'SOL/USD', 'KCRY', NULL, NULL, NULL, 'crypto', NULL, 'SOL', 'USD', 0.01, 2, NULL, 1, 0.01, 0.01, 2, NULL, '{"retail":"0.50","professional":"0.20"}'::jsonb, 'sim-crypto', 'active', true),
  ('XRPUSD', 'XRP/USD', 'KCRY', NULL, NULL, NULL, 'crypto', NULL, 'XRP', 'USD', 0.0001, 4, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.50","professional":"0.20"}'::jsonb, 'sim-crypto', 'active', true),
  ('US500', 'US 500', 'KSIM', NULL, NULL, NULL, 'cfd', 'index', NULL, 'USD', 0.1, 1, NULL, 1, 0.1, 0.1, 1, '{"timezone":"America/Chicago","weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","16:00"],["17:00","24:00"]],"tue":[["00:00","16:00"],["17:00","24:00"]],"wed":[["00:00","16:00"],["17:00","24:00"]],"thu":[["00:00","16:00"],["17:00","24:00"]],"fri":[["00:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-index-cfd', 'active', true),
  ('NAS100', 'US Tech 100', 'KSIM', NULL, NULL, NULL, 'cfd', 'index', NULL, 'USD', 0.1, 1, NULL, 1, 0.1, 0.1, 1, '{"timezone":"America/Chicago","weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","16:00"],["17:00","24:00"]],"tue":[["00:00","16:00"],["17:00","24:00"]],"wed":[["00:00","16:00"],["17:00","24:00"]],"thu":[["00:00","16:00"],["17:00","24:00"]],"fri":[["00:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-index-cfd', 'active', true),
  ('US30', 'US 30', 'KSIM', NULL, NULL, NULL, 'cfd', 'index', NULL, 'USD', 1, 0, NULL, 1, 0.1, 0.1, 1, '{"timezone":"America/Chicago","weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","16:00"],["17:00","24:00"]],"tue":[["00:00","16:00"],["17:00","24:00"]],"wed":[["00:00","16:00"],["17:00","24:00"]],"thu":[["00:00","16:00"],["17:00","24:00"]],"fri":[["00:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-index-cfd', 'active', true),
  ('GER40', 'Germany 40', 'KSIM', NULL, NULL, NULL, 'cfd', 'index', NULL, 'EUR', 0.5, 1, NULL, 1, 0.1, 0.1, 1, '{"timezone":"Europe/Berlin","weekly":{"mon":[["08:00","22:00"]],"tue":[["08:00","22:00"]],"wed":[["08:00","22:00"]],"thu":[["08:00","22:00"]],"fri":[["08:00","22:00"]]}}'::jsonb, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-index-cfd', 'active', true),
  ('UK100', 'UK 100', 'KSIM', NULL, NULL, NULL, 'cfd', 'index', NULL, 'GBP', 0.1, 1, NULL, 1, 0.1, 0.1, 1, '{"timezone":"Europe/London","weekly":{"mon":[["08:00","22:00"]],"tue":[["08:00","22:00"]],"wed":[["08:00","22:00"]],"thu":[["08:00","22:00"]],"fri":[["08:00","22:00"]]}}'::jsonb, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-index-cfd', 'active', true),
  ('JPN225', 'Japan 225', 'KSIM', NULL, NULL, NULL, 'cfd', 'index', NULL, 'JPY', 5, 0, NULL, 1, 0.1, 0.1, 1, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-index-cfd', 'active', true),
  ('AAPL', 'Apple Inc.', 'XNAS', 'AAPL', 'US0378331005', NULL, 'equity', NULL, NULL, 'USD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xnas', 'active', true),
  ('NVDA', 'NVIDIA Corporation', 'XNAS', 'NVDA', 'US67066G1040', NULL, 'equity', NULL, NULL, 'USD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xnas', 'active', true),
  ('MSFT', 'Microsoft Corporation', 'XNAS', 'MSFT', 'US5949181045', NULL, 'equity', NULL, NULL, 'USD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xnas', 'active', true),
  ('AMZN', 'Amazon.com, Inc.', 'XNAS', 'AMZN', 'US0231351067', NULL, 'equity', NULL, NULL, 'USD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xnas', 'active', true),
  ('TSLA', 'Tesla, Inc.', 'XNAS', 'TSLA', 'US88160R1014', NULL, 'equity', NULL, NULL, 'USD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xnas', 'active', true),
  ('GOOGL', 'Alphabet Inc. Class A', 'XNAS', 'GOOGL', 'US02079K3059', NULL, 'equity', NULL, NULL, 'USD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xnas', 'active', true),
  ('WTI', 'WTI Crude Oil', 'KSIM', NULL, NULL, NULL, 'energy', NULL, NULL, 'USD', 0.01, 2, NULL, 1000, 1, 1, 0, '{"timezone":"America/Chicago","weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","16:00"],["17:00","24:00"]],"tue":[["00:00","16:00"],["17:00","24:00"]],"wed":[["00:00","16:00"],["17:00","24:00"]],"thu":[["00:00","16:00"],["17:00","24:00"]],"fri":[["00:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, '{"retail":"0.10","professional":"0.05"}'::jsonb, 'sim-energy', 'active', true),
  ('BRENT', 'Brent Crude Oil', 'KSIM', NULL, NULL, NULL, 'energy', NULL, NULL, 'USD', 0.01, 2, NULL, 1000, 1, 1, 0, '{"timezone":"America/Chicago","weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","16:00"],["17:00","24:00"]],"tue":[["00:00","16:00"],["17:00","24:00"]],"wed":[["00:00","16:00"],["17:00","24:00"]],"thu":[["00:00","16:00"],["17:00","24:00"]],"fri":[["00:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, '{"retail":"0.10","professional":"0.05"}'::jsonb, 'sim-energy', 'active', true),
  ('NATGAS', 'Natural Gas', 'KSIM', NULL, NULL, NULL, 'energy', NULL, NULL, 'USD', 0.001, 3, NULL, 10000, 1, 1, 0, '{"timezone":"America/Chicago","weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","16:00"],["17:00","24:00"]],"tue":[["00:00","16:00"],["17:00","24:00"]],"wed":[["00:00","16:00"],["17:00","24:00"]],"thu":[["00:00","16:00"],["17:00","24:00"]],"fri":[["00:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, '{"retail":"0.10","professional":"0.05"}'::jsonb, 'sim-energy', 'active', true),
  ('7203.XTKS', 'Toyota Motor Corporation', 'XTKS', '7203', 'JP3633400001', NULL, 'equity', NULL, NULL, 'JPY', 0.5, 1, NULL, 1, 100, 100, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xtks', 'active', true),
  ('0700.XHKG', 'Tencent Holdings Ltd.', 'XHKG', '0700', 'KYG875721634', NULL, 'equity', NULL, NULL, 'HKD', 0.2, 1, NULL, 1, 100, 100, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xhkg', 'active', true),
  ('600519.XSHG', 'Kweichow Moutai Co., Ltd.', 'XSHG', '600519', NULL, NULL, 'equity', NULL, NULL, 'CNY', 0.01, 2, NULL, 1, 100, 100, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xshg', 'active', true),
  ('RELIANCE.XNSE', 'Reliance Industries Ltd.', 'XNSE', 'RELIANCE', 'INE002A01018', NULL, 'equity', NULL, NULL, 'INR', 0.05, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xnse', 'active', true),
  ('NPN.XJSE', 'Naspers Ltd.', 'XJSE', 'NPN', NULL, NULL, 'equity', NULL, NULL, 'ZAR', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xjse', 'active', true),
  ('PETR4.BVMF', 'Petróleo Brasileiro S.A. PN', 'BVMF', 'PETR4', 'BRPETRACNPR6', NULL, 'equity', NULL, NULL, 'BRL', 0.01, 2, NULL, 1, 100, 100, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-bvmf', 'active', true),
  ('BHP.XASX', 'BHP Group Ltd.', 'XASX', 'BHP', 'AU000000BHP4', NULL, 'equity', NULL, NULL, 'AUD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xasx', 'active', true),
  ('AIR.XNZE', 'Air New Zealand Ltd.', 'XNZE', 'AIR', NULL, NULL, 'equity', NULL, NULL, 'NZD', 0.005, 3, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xnze', 'active', true),
  ('HSBA.XLON', 'HSBC Holdings plc', 'XLON', 'HSBA', 'GB0005405286', NULL, 'equity', NULL, NULL, 'GBP', 0.001, 3, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xlon', 'active', true),
  ('SAP.XETR', 'SAP SE', 'XETR', 'SAP', 'DE0007164600', NULL, 'equity', NULL, NULL, 'EUR', 0.02, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xetr', 'active', true),
  ('MC.XPAR', 'LVMH Moët Hennessy Louis Vuitton', 'XPAR', 'MC', 'FR0000121014', NULL, 'equity', NULL, NULL, 'EUR', 0.1, 1, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xpar', 'active', true),
  ('SHOP.XTSE', 'Shopify Inc.', 'XTSE', 'SHOP', NULL, NULL, 'equity', NULL, NULL, 'CAD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-xtse', 'active', true),
  ('SPY', 'SPDR S&P 500 ETF Trust', 'ARCX', 'SPY', 'US78462F1030', NULL, 'etf', NULL, NULL, 'USD', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"0.20","professional":"0.10"}'::jsonb, 'sim-equity-arcx', 'active', true),
  ('ESZ6', 'E-mini S&P 500 Dec 2026 (simulated)', 'XCME', 'ESZ6', NULL, NULL, 'future', 'index', NULL, 'USD', 0.25, 2, NULL, 50, 1, 1, 0, NULL, '{"retail":"0.06","professional":"0.05"}'::jsonb, 'sim-future', 'active', true),
  ('ZCZ6', 'Corn Dec 2026 (simulated)', 'XCME', 'ZCZ6', NULL, NULL, 'future', 'agri', NULL, 'USD', 0.0025, 4, NULL, 5000, 1, 1, 0, NULL, '{"retail":"0.06","professional":"0.05"}'::jsonb, 'sim-future', 'active', true),
  ('SPY261218C550', 'SPY 18 Dec 2026 550 Call (simulated)', 'XCBO', NULL, NULL, NULL, 'option', 'etf', NULL, 'USD', 0.05, 2, NULL, 100, 1, 1, 0, NULL, '{"retail":"1.00","professional":"1.00"}'::jsonb, 'sim-option', 'active', true),
  ('UST10Y', 'US Treasury 10Y (simulated)', 'KSIM', NULL, NULL, NULL, 'bond', NULL, NULL, 'USD', 0.015625, 6, NULL, 1000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.02"}'::jsonb, 'sim-bond', 'active', true),
  ('N225.IDX', 'Nikkei 225 index level (reference, simulated)', 'XTKS', NULL, NULL, NULL, 'index', NULL, NULL, 'JPY', 0.01, 2, NULL, 1, 1, 1, 0, NULL, '{"retail":"1.00","professional":"1.00"}'::jsonb, 'sim-none', 'active', true),
  ('WHEAT', 'Wheat (simulated)', 'KSIM', NULL, NULL, NULL, 'agri', NULL, NULL, 'USD', 0.0025, 4, NULL, 5000, 1, 1, 0, '{"timezone":"America/Chicago","weekly":{"sun":[["17:00","24:00"]],"mon":[["00:00","16:00"],["17:00","24:00"]],"tue":[["00:00","16:00"],["17:00","24:00"]],"wed":[["00:00","16:00"],["17:00","24:00"]],"thu":[["00:00","16:00"],["17:00","24:00"]],"fri":[["00:00","16:00"]]},"holidays":[{"date":"2026-01-01","name":"New Year''s Day"},{"date":"2026-12-25","name":"Christmas Day"}]}'::jsonb, '{"retail":"0.10","professional":"0.05"}'::jsonb, 'sim-agri', 'active', true),
  ('KGEF', 'KORA Simulated Global Equity Fund', 'KSIM', NULL, NULL, NULL, 'fund', 'equity', NULL, 'USD', 0.0001, 4, NULL, 1, 0.001, 0.001, 3, NULL, '{"retail":"1.00","professional":"1.00"}'::jsonb, 'sim-fund', 'active', true);

INSERT INTO instrument_aliases (source, vendor_symbol, symbol) VALUES
  ('broker-fxcfd', 'EUR_USD', 'EURUSD'),
  ('broker-fxcfd', 'GBP_USD', 'GBPUSD'),
  ('broker-fxcfd', 'USD_JPY', 'USDJPY'),
  ('broker-fxcfd', 'USD_CHF', 'USDCHF'),
  ('broker-fxcfd', 'AUD_USD', 'AUDUSD'),
  ('broker-fxcfd', 'USD_CAD', 'USDCAD'),
  ('broker-fxcfd', 'NZD_USD', 'NZDUSD'),
  ('broker-fxcfd', 'EUR_GBP', 'EURGBP'),
  ('broker-fxcfd', 'EUR_JPY', 'EURJPY'),
  ('broker-fxcfd', 'GBP_JPY', 'GBPJPY'),
  ('broker-fxcfd', 'XAU_USD', 'XAUUSD'),
  ('broker-fxcfd', 'XAG_USD', 'XAGUSD'),
  ('crypto-testnet', 'BTCUSDT', 'BTCUSD'),
  ('crypto-testnet', 'ETHUSDT', 'ETHUSD'),
  ('crypto-testnet', 'SOLUSDT', 'SOLUSD'),
  ('crypto-testnet', 'XRPUSDT', 'XRPUSD'),
  ('equities-provider', 'AAPL', 'AAPL'),
  ('equities-provider', 'NVDA', 'NVDA'),
  ('equities-provider', 'MSFT', 'MSFT'),
  ('equities-provider', 'AMZN', 'AMZN'),
  ('equities-provider', 'TSLA', 'TSLA'),
  ('equities-provider', 'GOOGL', 'GOOGL'),
  ('equities-provider', 'SPY', 'SPY');
