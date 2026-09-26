-- 0003 trading core (goal 03, ADR 0003): registry-driven cost and execution parameters, paper
-- accounts, orders, fills, positions, a balanced double-entry ledger, equity snapshots, alerts,
-- reconciliation runs and the LIVE compliance sign-off record. Runs as kora_owner.
-- Every seeded value below is a SIMULATED placeholder (OQ-M1, OQ-B1, OQ-R3).

-- ---------------------------------------------------------------------------
-- Registry: fee schedules and per-asset-class execution parameters
-- ---------------------------------------------------------------------------
CREATE TABLE fee_schedules (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,64}$'),
  label text NOT NULL,
  commission_bps numeric NOT NULL DEFAULT 0 CHECK (commission_bps >= 0),
  commission_per_unit numeric NOT NULL DEFAULT 0 CHECK (commission_per_unit >= 0),
  commission_min numeric NOT NULL DEFAULT 0 CHECK (commission_min >= 0),
  swap_long_bps numeric NOT NULL DEFAULT 0,       -- annual, signed from the customer's view (charge < 0)
  swap_short_bps numeric NOT NULL DEFAULT 0,
  fx_conversion_bps numeric NOT NULL DEFAULT 0 CHECK (fx_conversion_bps >= 0),
  simulated boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fee_schedules (id, label, commission_bps, commission_per_unit, commission_min, swap_long_bps, swap_short_bps, fx_conversion_bps) VALUES
  ('sim-fx', 'SIMULATED FX', 0.2, 0, 0, -150, -50, 25),
  ('sim-metal', 'SIMULATED metals', 1, 0, 0, -200, -100, 25),
  ('sim-crypto', 'SIMULATED crypto', 10, 0, 0, -1000, -1000, 25),
  ('sim-index-cfd', 'SIMULATED index CFDs', 1, 0, 0, -250, -100, 25),
  ('sim-energy', 'SIMULATED energy', 2, 0, 0, -300, -100, 25),
  ('sim-agri', 'SIMULATED agriculture', 2, 0, 0, -300, -100, 25),
  ('sim-bond', 'SIMULATED bonds', 1, 0, 0, 0, 0, 25),
  ('sim-future', 'SIMULATED futures (per contract)', 0, 1.50, 0, 0, 0, 25),
  ('sim-option', 'SIMULATED options (per contract)', 0, 0.65, 0, 0, 0, 25),
  ('sim-fund', 'SIMULATED funds', 0, 0, 0, 0, 0, 25),
  ('sim-none', 'SIMULATED reference level (no fees)', 0, 0, 0, 0, 0, 25),
  ('sim-equity-xnas', 'SIMULATED US equities (per share, minimum)', 0, 0.005, 1, -300, -200, 25),
  ('sim-equity-arcx', 'SIMULATED US ETFs (per share, minimum)', 0, 0.005, 1, -300, -200, 25);

-- Every other venue's equities: 5 bps, no minimum.
INSERT INTO fee_schedules (id, label, commission_bps, swap_long_bps, swap_short_bps, fx_conversion_bps)
SELECT DISTINCT fee_schedule_id, 'SIMULATED equities ' || upper(substr(fee_schedule_id, 12)), 5, -300, -200, 25
FROM instruments WHERE fee_schedule_id LIKE 'sim-equity-%'
ON CONFLICT (id) DO NOTHING;

CREATE TABLE asset_class_trading (
  asset_class text PRIMARY KEY REFERENCES asset_classes (asset_class),
  multiplier_mode text NOT NULL CHECK (multiplier_mode IN ('unit', 'contract', 'percent_of_par')),
  fat_finger_pct numeric NOT NULL CHECK (fat_finger_pct > 0),
  impact_ticks numeric NOT NULL CHECK (impact_ticks >= 0 AND impact_ticks = trunc(impact_ticks)),
  vol_factor numeric NOT NULL CHECK (vol_factor >= 0),
  max_levels integer NOT NULL CHECK (max_levels BETWEEN 1 AND 50),
  simulated boolean NOT NULL DEFAULT true
);

INSERT INTO asset_class_trading (asset_class, multiplier_mode, fat_finger_pct, impact_ticks, vol_factor, max_levels) VALUES
  ('fx', 'unit', 1, 0, 0.1, 10),
  ('metal', 'unit', 2, 1, 0.1, 10),
  ('crypto', 'unit', 5, 1, 0.1, 10),
  ('equity', 'unit', 5, 1, 0.1, 10),
  ('etf', 'unit', 5, 1, 0.1, 10),
  ('bond', 'percent_of_par', 2, 1, 0.1, 10),
  ('future', 'contract', 3, 1, 0.1, 10),
  ('option', 'contract', 25, 1, 0.1, 10),
  ('energy', 'contract', 5, 1, 0.1, 10),
  ('agri', 'contract', 5, 1, 0.1, 10),
  ('index', 'unit', 3, 1, 0.1, 10),
  ('cfd', 'unit', 3, 1, 0.1, 10),
  ('fund', 'unit', 5, 0, 0, 10);

-- SIMULATED conversion pairs (seed catalog: packages/market-data/src/seed/instruments.ts).
INSERT INTO instruments (symbol, display_name, venue, venue_symbol, isin, figi, asset_class, underlying_class, base_ccy, quote_ccy, tick_size, price_precision, pip_size, contract_size, min_qty, qty_step, qty_precision, trading_sessions, margin_rates, fee_schedule_id, status, simulated) VALUES
  ('USDHKD', 'USD/HKD', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'USD', 'HKD', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true),
  ('USDCNY', 'USD/CNY', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'USD', 'CNY', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true),
  ('USDINR', 'USD/INR', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'USD', 'INR', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true),
  ('USDZAR', 'USD/ZAR', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'USD', 'ZAR', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true),
  ('USDBRL', 'USD/BRL', 'KSIM', NULL, NULL, NULL, 'fx', NULL, 'USD', 'BRL', 0.00001, 5, 0.0001, 100000, 1000, 1000, 0, NULL, '{"retail":"0.05","professional":"0.01"}'::jsonb, 'sim-fx', 'active', true);

INSERT INTO instrument_aliases (source, vendor_symbol, symbol) VALUES
  ('broker-fxcfd', 'USD_HKD', 'USDHKD'),
  ('broker-fxcfd', 'USD_CNY', 'USDCNY'),
  ('broker-fxcfd', 'USD_INR', 'USDINR'),
  ('broker-fxcfd', 'USD_ZAR', 'USDZAR'),
  ('broker-fxcfd', 'USD_BRL', 'USDBRL');

ALTER TABLE instruments ADD CONSTRAINT instruments_fee_schedule_fk FOREIGN KEY (fee_schedule_id) REFERENCES fee_schedules (id);

-- ---------------------------------------------------------------------------
-- LIVE path: compliance sign-off record (never written by the runtime role)
-- ---------------------------------------------------------------------------
CREATE TABLE compliance_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('live_trading')),
  signed_by text NOT NULL,
  signer_role text NOT NULL,
  document_ref text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'PAPER' CHECK (environment IN ('PAPER', 'LIVE')),
  base_currency text NOT NULL DEFAULT 'USD' CHECK (base_currency ~ '^[A-Z]{3}$'),
  margin_tier text NOT NULL DEFAULT 'retail' CHECK (margin_tier ~ '^[a-z_]{1,32}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  starting_cash numeric NOT NULL CHECK (starting_cash > 0),
  cash numeric NOT NULL,                             -- cache of the ledger 'cash' balance (reconciled)
  trading_halted boolean NOT NULL DEFAULT false,
  halt_scope text CHECK (halt_scope IN ('robots', 'robots_cancel', 'robots_cancel_flatten')),
  halted_at timestamptz,
  halted_by text,
  halt_reason text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  risk_limits jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(risk_limits) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, environment),
  CONSTRAINT accounts_halt_consistent CHECK (trading_halted = (halt_scope IS NOT NULL))
);

CREATE FUNCTION accounts_live_requires_signoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.environment = 'LIVE' AND NOT EXISTS (
    SELECT 1 FROM compliance_signoffs WHERE scope = 'live_trading' AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'LIVE accounts require an active compliance sign-off (goal 09)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_live_signoff BEFORE INSERT OR UPDATE OF environment ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_live_requires_signoff();

-- ---------------------------------------------------------------------------
-- Orders, fills, positions
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  client_order_id text CHECK (client_order_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  request_hash char(64),
  parent_order_id uuid REFERENCES orders (id),
  oco_group uuid,
  role text NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'stop_loss', 'take_profit', 'oco_leg')),
  symbol text NOT NULL REFERENCES instruments (symbol),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  type text NOT NULL CHECK (type IN ('market', 'limit', 'stop', 'stop_limit', 'trailing', 'bracket', 'oco')),
  exec_type text NOT NULL CHECK (exec_type IN ('market', 'limit', 'stop', 'stop_limit', 'trailing', 'none')),
  qty numeric NOT NULL CHECK (qty > 0),
  filled_qty numeric NOT NULL DEFAULT 0 CHECK (filled_qty >= 0 AND filled_qty <= qty),
  avg_fill_price numeric CHECK (avg_fill_price > 0),
  limit_price numeric CHECK (limit_price > 0),
  stop_price numeric CHECK (stop_price > 0),
  trail_amount numeric CHECK (trail_amount > 0),
  trail_ref_price numeric,                           -- best price seen since placement (trailing stops)
  stop_loss_price numeric CHECK (stop_loss_price > 0),
  take_profit_price numeric CHECK (take_profit_price > 0),
  tif text NOT NULL CHECK (tif IN ('day', 'gtc', 'ioc', 'fok', 'gtd')),
  expire_at timestamptz,
  reduce_only boolean NOT NULL DEFAULT false,
  post_only boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source ~ '^(manual|ai-draft-accepted|kill-switch|robot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  status text NOT NULL CHECK (status IN ('new', 'accepted', 'working', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired')),
  reject_code text,
  reject_message text,
  cancel_reason text,
  triggered_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT orders_client_id_uq UNIQUE (account_id, client_order_id)
);
CREATE INDEX orders_account_status_idx ON orders (account_id, status, created_at DESC);
CREATE INDEX orders_open_symbol_idx ON orders (symbol) WHERE status IN ('new', 'accepted', 'working', 'partially_filled');
CREATE INDEX orders_account_created_idx ON orders (account_id, created_at DESC);
CREATE INDEX orders_oco_idx ON orders (oco_group) WHERE oco_group IS NOT NULL;
CREATE INDEX orders_parent_idx ON orders (parent_order_id) WHERE parent_order_id IS NOT NULL;

CREATE TABLE fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES instruments (symbol),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  qty numeric NOT NULL CHECK (qty > 0),
  price numeric NOT NULL CHECK (price > 0),
  quote_at_decision jsonb NOT NULL,
  reference_price numeric NOT NULL,
  slippage numeric NOT NULL,                         -- adverse price difference vs reference (price units)
  commission numeric NOT NULL CHECK (commission >= 0),       -- base currency
  spread_cost numeric NOT NULL CHECK (spread_cost >= 0),     -- base currency (embedded in price)
  fx_rate numeric NOT NULL CHECK (fx_rate > 0),              -- quote → base at fill time
  fx_conversion_cost numeric NOT NULL CHECK (fx_conversion_cost >= 0),
  realized_pnl numeric NOT NULL,                             -- base currency, gross of fees
  liquidity text NOT NULL CHECK (liquidity IN ('taker', 'maker')),
  ts timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fills_account_ts_idx ON fills (account_id, ts);
CREATE INDEX fills_order_idx ON fills (order_id);

CREATE TABLE positions (
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES instruments (symbol),
  qty numeric NOT NULL,                              -- signed, long > 0
  avg_price numeric NOT NULL CHECK (avg_price >= 0),
  realized_pnl numeric NOT NULL DEFAULT 0,           -- cumulative, base currency
  opened_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, symbol),
  CONSTRAINT positions_flat_avg CHECK (qty <> 0 OR avg_price = 0)
);

-- ---------------------------------------------------------------------------
-- Double-entry ledger (append-only for the runtime role; every journal balances)
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('deposit', 'fill', 'swap', 'adjustment')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ref_type text,
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ledger_journals_account_idx ON ledger_journals (account_id, created_at);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES ledger_journals (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  ledger_account text NOT NULL CHECK (ledger_account IN ('cash', 'capital', 'pnl', 'fees', 'swap', 'fx')),
  amount numeric NOT NULL CHECK (amount <> 0 AND scale(amount) <= 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, ledger_account);
CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_id);

CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO total FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger journal % is unbalanced by %', NEW.journal_id, total USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

CREATE FUNCTION ledger_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER ledger_journals_no_update BEFORE UPDATE ON ledger_journals FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();
CREATE TRIGGER fills_no_update BEFORE UPDATE ON fills FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

-- ---------------------------------------------------------------------------
-- Equity snapshots (day / week start for loss limits and day P&L)
-- ---------------------------------------------------------------------------
CREATE TABLE account_equity_snapshots (
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('day', 'week')),
  period_start date NOT NULL,
  equity numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, period, period_start)
);

-- Daily roll bookkeeping (swaps charged once per account per roll date).
CREATE TABLE account_rolls (
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  roll_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, roll_date)
);

-- ---------------------------------------------------------------------------
-- Alerts and reconciliation
-- ---------------------------------------------------------------------------
CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  kind text NOT NULL CHECK (kind ~ '^[a-z0-9_.]{1,64}$'),
  account_id uuid REFERENCES accounts (id) ON DELETE CASCADE,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  acknowledged_by text
);
CREATE INDEX alerts_open_idx ON alerts (created_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX alerts_account_idx ON alerts (account_id, created_at DESC);

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  requested_by text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  accounts_checked integer NOT NULL CHECK (accounts_checked >= 0),
  mismatches integer NOT NULL CHECK (mismatches >= 0),
  details jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX reconciliation_runs_started_idx ON reconciliation_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT SELECT ON fee_schedules, asset_class_trading, compliance_signoffs TO kora_app;
GRANT SELECT, INSERT, UPDATE ON accounts, orders, positions, account_equity_snapshots TO kora_app;
GRANT SELECT, INSERT ON fills, ledger_journals, ledger_entries, account_rolls, reconciliation_runs TO kora_app;
GRANT SELECT, INSERT, UPDATE ON alerts TO kora_app;
REVOKE DELETE, TRUNCATE ON fills, ledger_journals, ledger_entries FROM kora_app;

GRANT SELECT ON fee_schedules, asset_class_trading, compliance_signoffs, accounts, orders, fills, positions,
  ledger_journals, ledger_entries, account_equity_snapshots, account_rolls, alerts, reconciliation_runs TO kora_audit_reader;
