-- 0040 Pro terminal (goal 04, ADR 0004): per-user terminal settings, named dockable layouts,
-- watchlists and server-evaluated price/indicator alerts. Goal 04 owns migrations 0040-0059.

ALTER TABLE user_preferences
  ADD COLUMN terminal jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(terminal) = 'object');

-- Named layouts (dockview JSON). The api caps each user at 20 layouts.
CREATE TABLE user_layouts (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  layout jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'object' AND octet_length(layout::text) <= 65536),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

CREATE TABLE watchlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  symbols text[] NOT NULL DEFAULT '{}' CHECK (cardinality(symbols) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX watchlists_user ON watchlists (user_id, position);

CREATE TABLE price_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES instruments (symbol),
  condition text NOT NULL CHECK (condition IN ('price_above', 'price_below', 'rsi_above', 'rsi_below')),
  threshold numeric(38, 18) NOT NULL CHECK (threshold > 0),
  timeframe text CHECK (timeframe IS NULL OR timeframe IN ('1m', '5m', '15m', '1h', '4h', '1D')),
  note text CHECK (note IS NULL OR char_length(note) <= 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  triggered_at timestamptz,
  triggered_value numeric(38, 18),
  CHECK ((status = 'triggered') = (triggered_at IS NOT NULL)),
  CHECK (condition IN ('price_above', 'price_below') OR timeframe IS NOT NULL)
);
CREATE INDEX price_alerts_active ON price_alerts (symbol) WHERE status = 'active';
CREATE INDEX price_alerts_user ON price_alerts (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_layouts, watchlists TO kora_app;
GRANT SELECT, INSERT, UPDATE ON price_alerts TO kora_app;
GRANT SELECT ON user_layouts, watchlists, price_alerts TO kora_audit_reader;
