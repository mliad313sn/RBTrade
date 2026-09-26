-- Goal 07: AI copilot — drafts (order ticket prefills, unapproved strategy versions) and the
-- calibration table (predictions vs outcomes, reliability bins). The AI never executes: nothing here
-- references an order submission path; a draft only records what a human may later confirm.

-- ---------------------------------------------------------------------------
-- Order drafts: pre-fill the goal 04 ticket; the user previews and confirms.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_order_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  surface text NOT NULL CHECK (surface IN ('chat', 'strip', 'why', 'robots', 'explain', 'eval')),
  symbol text NOT NULL REFERENCES instruments (symbol),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  type text NOT NULL CHECK (type IN ('market', 'limit')),
  qty numeric NOT NULL CHECK (qty > 0),
  limit_price numeric,
  stop_loss_price numeric,
  take_profit_price numeric,
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 300),
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted', 'rejected')),
  order_id uuid REFERENCES orders (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz
);
CREATE INDEX ai_order_drafts_user_idx ON ai_order_drafts (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Strategy drafts: a validated candidate definition. Only a human saves a version
-- (POST /strategies/:id/versions); this row never creates one.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_strategy_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  strategy_id uuid NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  base_version_id uuid NOT NULL REFERENCES strategy_versions (id),
  definition jsonb NOT NULL,
  param_changes jsonb NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  validation jsonb NOT NULL,
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 300),
  model_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted', 'rejected')),
  saved_version_id uuid REFERENCES strategy_versions (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz
);
CREATE INDEX ai_strategy_drafts_user_idx ON ai_strategy_drafts (user_id, created_at DESC);

-- A draft decision is final: draft → accepted | rejected, once; content never changes.
CREATE FUNCTION ai_drafts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI drafts are append-only';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'AI draft % is already %', OLD.id, OLD.status;
  END IF;
  IF NEW.status = 'draft' THEN
    RAISE EXCEPTION 'AI draft update must decide it';
  END IF;
  IF to_jsonb(NEW) - ARRAY['status', 'decided_at', 'order_id', 'saved_version_id']
     <> to_jsonb(OLD) - ARRAY['status', 'decided_at', 'order_id', 'saved_version_id'] THEN
    RAISE EXCEPTION 'AI draft content is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_order_drafts_guard BEFORE UPDATE OR DELETE ON ai_order_drafts
  FOR EACH ROW EXECUTE FUNCTION ai_drafts_guard();
CREATE TRIGGER ai_strategy_drafts_guard BEFORE UPDATE OR DELETE ON ai_strategy_drafts
  FOR EACH ROW EXECUTE FUNCTION ai_drafts_guard();

-- ---------------------------------------------------------------------------
-- Calibration: every prediction is logged before its outcome is known; bins are the
-- reliability table the UI reads ("when we said 0.6, it worked 57% of the time, n=212").
-- Goal 07B writes its own model keys (trend forecasts per model / region / horizon) here.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_predictions (
  id bigserial PRIMARY KEY,
  model_key text NOT NULL CHECK (length(model_key) BETWEEN 3 AND 160),
  subject text NOT NULL,
  horizon text NOT NULL,
  predicted numeric(6, 5) NOT NULL CHECK (predicted >= 0 AND predicted <= 1),
  outcome boolean,
  net_return double precision,
  source text NOT NULL CHECK (source IN ('live', 'backtest_oos', 'history_replay', 'seed')),
  predicted_at timestamptz NOT NULL,
  resolved_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (resolved_at IS NULL OR resolved_at >= predicted_at)
);
CREATE INDEX ai_predictions_model_idx ON ai_predictions (model_key, predicted_at DESC);
CREATE UNIQUE INDEX ai_predictions_subject_uq ON ai_predictions (model_key, subject, predicted_at);

CREATE TABLE ai_calibration_bins (
  model_key text NOT NULL,
  bin smallint NOT NULL CHECK (bin BETWEEN 0 AND 9),
  lo numeric(3, 2) NOT NULL,
  hi numeric(3, 2) NOT NULL CHECK (hi > lo),
  n integer NOT NULL CHECK (n >= 0),
  hits integer NOT NULL CHECK (hits >= 0 AND hits <= n),
  mean_predicted double precision,
  mean_net_return double precision,
  net_return_sd double precision,
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (model_key, bin)
);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON ai_order_drafts, ai_strategy_drafts TO kora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_predictions, ai_calibration_bins TO kora_app;
GRANT USAGE, SELECT ON SEQUENCE ai_predictions_id_seq TO kora_app;
GRANT SELECT ON ai_order_drafts, ai_strategy_drafts, ai_predictions, ai_calibration_bins TO kora_audit_reader;
