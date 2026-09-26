-- Goal 07B: Market intelligence — scanner runs, latest features per instrument, emerging trends and
-- trend forecasts. Detectors store numbers only (jsonb of feature values). Forecast probabilities
-- shown to users always come from ai_calibration_bins (goal 07); rows here keep the raw model output
-- and point at the ai_predictions row written before the outcome was known. All data is SIMULATED.

CREATE TABLE intel_scans (
  id bigserial PRIMARY KEY,
  timeframe text NOT NULL CHECK (timeframe ~ '^[0-9]{1,3}[smhDW]$'),
  bar_ts timestamptz,
  instruments integer NOT NULL CHECK (instruments >= 0),
  scan_ms double precision NOT NULL,
  elapsed_ms double precision NOT NULL,
  guard_checkpoints integer NOT NULL DEFAULT 0,
  trigger text NOT NULL CHECK (trigger IN ('bar_close', 'manual', 'test')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX intel_scans_tf_idx ON intel_scans (timeframe, created_at DESC);

CREATE TABLE intel_features (
  symbol text NOT NULL REFERENCES instruments (symbol),
  timeframe text NOT NULL,
  bar_ts timestamptz,
  last_close double precision,
  features jsonb NOT NULL,
  scan_id bigint NOT NULL REFERENCES intel_scans (id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (symbol, timeframe)
);

CREATE TABLE intel_trends (
  id bigserial PRIMARY KEY,
  scan_id bigint NOT NULL REFERENCES intel_scans (id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES instruments (symbol),
  timeframe text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('up', 'down', 'range', 'breakout_up', 'breakout_down', 'reversal', 'vol_regime')),
  score double precision NOT NULL CHECK (score >= 0 AND score <= 1),
  bar_ts timestamptz,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX intel_trends_scan_idx ON intel_trends (scan_id);
CREATE INDEX intel_trends_symbol_idx ON intel_trends (symbol, detected_at DESC);

CREATE TABLE intel_forecasts (
  id bigserial PRIMARY KEY,
  scan_id bigint NOT NULL REFERENCES intel_scans (id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES instruments (symbol),
  timeframe text NOT NULL,
  horizon text NOT NULL CHECK (horizon ~ '^[0-9a-z]{1,8}$'),
  horizon_bars integer NOT NULL CHECK (horizon_bars > 0),
  model_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'insufficient_data')),
  predicted_at timestamptz,
  direction text CHECK (direction IN ('up', 'down')),
  p_up double precision CHECK (p_up IS NULL OR (p_up >= 0 AND p_up <= 1)),
  p_direction double precision CHECK (p_direction IS NULL OR (p_direction >= 0.5 AND p_direction <= 1)),
  skill jsonb NOT NULL DEFAULT '{}'::jsonb,
  drivers jsonb NOT NULL DEFAULT '[]'::jsonb,
  prediction_id bigint REFERENCES ai_predictions (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX intel_forecasts_symbol_idx ON intel_forecasts (symbol, horizon, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON intel_scans, intel_features, intel_trends, intel_forecasts TO kora_app;
GRANT USAGE, SELECT ON SEQUENCE intel_scans_id_seq, intel_trends_id_seq, intel_forecasts_id_seq TO kora_app;
GRANT SELECT ON intel_scans, intel_features, intel_trends, intel_forecasts TO kora_audit_reader;
