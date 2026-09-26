-- Goal 06: Robot Trader — strategies (immutable versions), backtests, trials, robots, signals,
-- tracking error, four-eyes risk sign-off and promotion records. PAPER only.

-- ---------------------------------------------------------------------------
-- Strategies and immutable versions
-- ---------------------------------------------------------------------------
CREATE TABLE strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  latest_version integer NOT NULL DEFAULT 1 CHECK (latest_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX strategies_owner_idx ON strategies (owner_id, updated_at DESC);

CREATE TABLE strategy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  schema_version integer NOT NULL,
  definition jsonb NOT NULL,
  author_id uuid NOT NULL REFERENCES users (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  parent_version_id uuid REFERENCES strategy_versions (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (strategy_id, version)
);
CREATE INDEX strategy_versions_hash_idx ON strategy_versions (strategy_id, content_hash);

CREATE FUNCTION robots_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (goal 06): rows cannot be changed or deleted', TG_TABLE_NAME;
END $$;
CREATE TRIGGER strategy_versions_immutable BEFORE UPDATE OR DELETE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION robots_block_mutation();

-- ---------------------------------------------------------------------------
-- Backtests and trials (overfitting controls: every configuration tried is counted)
-- ---------------------------------------------------------------------------
CREATE TABLE backtest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES strategy_versions (id),
  user_id uuid NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('backtest', 'walk_forward', 'optimise', 'sensitivity')),
  request jsonb NOT NULL,
  summary jsonb NOT NULL,
  result jsonb NOT NULL,
  trials_added integer NOT NULL DEFAULT 0,
  data_simulated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX backtest_runs_strategy_idx ON backtest_runs (strategy_id, created_at DESC);
CREATE INDEX backtest_runs_user_idx ON backtest_runs (user_id, created_at DESC);
CREATE TRIGGER backtest_runs_immutable BEFORE UPDATE OR DELETE ON backtest_runs
  FOR EACH ROW EXECUTE FUNCTION robots_block_mutation();

CREATE TABLE strategy_trials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  -- Hash of the complete configuration tried (definition with the parameter values applied).
  config_hash char(64) NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  params jsonb NOT NULL,
  version_id uuid NOT NULL REFERENCES strategy_versions (id),
  run_id uuid NOT NULL REFERENCES backtest_runs (id),
  is_period_sharpe double precision,
  oos_period_sharpe double precision,
  is_sharpe double precision,
  oos_sharpe double precision,
  observations integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (strategy_id, config_hash)
);
CREATE TRIGGER strategy_trials_immutable BEFORE UPDATE OR DELETE ON strategy_trials
  FOR EACH ROW EXECUTE FUNCTION robots_block_mutation();

-- ---------------------------------------------------------------------------
-- Robots
-- ---------------------------------------------------------------------------
CREATE TABLE robots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  strategy_id uuid NOT NULL REFERENCES strategies (id),
  version_id uuid NOT NULL REFERENCES strategy_versions (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  mode text NOT NULL DEFAULT 'PAPER' CHECK (mode IN ('PAPER', 'LIVE')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'stopped')),
  allocation numeric NOT NULL CHECK (allocation > 0),
  limits jsonb NOT NULL,
  limits_hash char(64) NOT NULL CHECK (limits_hash ~ '^[0-9a-f]{64}$'),
  peak_equity numeric,
  day_start text CHECK (day_start ~ '^\d{4}-\d{2}-\d{2}$'),
  day_start_equity numeric,
  week_start text CHECK (week_start ~ '^\d{4}-\d{2}-\d{2}$'),
  week_start_equity numeric,
  pause_reason text,
  paused_at timestamptz,
  started_at timestamptz,
  paper_started_at timestamptz,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX robots_owner_idx ON robots (owner_id, created_at DESC);
CREATE INDEX robots_running_idx ON robots (status) WHERE status = 'running';

-- LIVE robots need a licensed broker, a compliance sign-off and LIVE_TRADING_ENABLED (Sponsor only).
CREATE FUNCTION robots_refuse_live() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode = 'LIVE' THEN
    RAISE EXCEPTION 'LIVE robots are not supported: KORA runs in PAPER only (goal 06, ADR 0006)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER robots_paper_only BEFORE INSERT OR UPDATE OF mode ON robots
  FOR EACH ROW EXECUTE FUNCTION robots_refuse_live();

-- Every decision the runner makes, with evaluated features and contributions (explainability).
CREATE TABLE robot_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id uuid NOT NULL REFERENCES robots (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES strategy_versions (id),
  symbol text NOT NULL REFERENCES instruments (symbol),
  bar_ts timestamptz NOT NULL,
  action text NOT NULL CHECK (action IN ('enter_long', 'enter_short', 'exit', 'hold', 'blocked', 'amend_stop')),
  reason text NOT NULL,
  conditions jsonb NOT NULL,
  features jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('none', 'submitted', 'rejected', 'refused')),
  outcome_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_id uuid REFERENCES orders (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (robot_id, symbol, bar_ts)
);
CREATE INDEX robot_signals_robot_idx ON robot_signals (robot_id, created_at DESC);
CREATE TRIGGER robot_signals_immutable BEFORE UPDATE OR DELETE ON robot_signals
  FOR EACH ROW EXECUTE FUNCTION robots_block_mutation();

-- Live-vs-backtest tracking error per UTC day (recomputed idempotently).
CREATE TABLE robot_tracking (
  robot_id uuid NOT NULL REFERENCES robots (id) ON DELETE CASCADE,
  day date NOT NULL,
  version_id uuid NOT NULL REFERENCES strategy_versions (id),
  live_return double precision NOT NULL,
  backtest_return double precision NOT NULL,
  tracking_error double precision NOT NULL CHECK (tracking_error >= 0),
  live_trades integer NOT NULL DEFAULT 0,
  backtest_trades integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (robot_id, day)
);

-- Four-eyes: a risk officer who is not the robot owner signs the exact limits (by hash).
CREATE TABLE robot_risk_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id uuid NOT NULL REFERENCES robots (id) ON DELETE CASCADE,
  limits_hash char(64) NOT NULL,
  signed_by uuid NOT NULL REFERENCES users (id),
  note text NOT NULL CHECK (length(note) BETWEEN 3 AND 500),
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX robot_risk_signoffs_robot_idx ON robot_risk_signoffs (robot_id, signed_at DESC);

CREATE FUNCTION robot_signoff_four_eyes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM robots WHERE id = NEW.robot_id AND owner_id = NEW.signed_by) THEN
    RAISE EXCEPTION 'four-eyes: the robot owner cannot sign its risk limits';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = NEW.signed_by AND role = 'risk_officer') THEN
    RAISE EXCEPTION 'only a risk officer can sign robot risk limits';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER robot_risk_signoffs_four_eyes BEFORE INSERT ON robot_risk_signoffs
  FOR EACH ROW EXECUTE FUNCTION robot_signoff_four_eyes();
CREATE TRIGGER robot_risk_signoffs_immutable BEFORE UPDATE OR DELETE ON robot_risk_signoffs
  FOR EACH ROW EXECUTE FUNCTION robots_block_mutation();

-- Promotion requests (recorded even while LIVE_TRADING_ENABLED=false blocks them).
CREATE TABLE robot_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id uuid NOT NULL REFERENCES robots (id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users (id),
  outcome text NOT NULL CHECK (outcome IN ('blocked_checklist', 'blocked_live_disabled', 'blocked_no_broker')),
  checklist jsonb NOT NULL,
  mfa_verified boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX robot_promotions_robot_idx ON robot_promotions (robot_id, created_at DESC);
CREATE TRIGGER robot_promotions_immutable BEFORE UPDATE OR DELETE ON robot_promotions
  FOR EACH ROW EXECUTE FUNCTION robots_block_mutation();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON strategies, robots, robot_tracking TO kora_app;
GRANT SELECT, INSERT ON strategy_versions, backtest_runs, strategy_trials, robot_signals,
  robot_risk_signoffs, robot_promotions TO kora_app;
GRANT SELECT ON strategies, strategy_versions, backtest_runs, strategy_trials, robots, robot_signals,
  robot_tracking, robot_risk_signoffs, robot_promotions TO kora_audit_reader;
