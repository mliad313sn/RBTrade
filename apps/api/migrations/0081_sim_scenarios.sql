-- Goal 08 (B-505): saved and named simulator scenarios per user (Novice Practice and the Pro
-- simulator). Inputs only; results are recomputed (deterministic, seeded) when a scenario is loaded.
CREATE TABLE sim_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('practice', 'pro')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object' AND octet_length(input::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, name)
);
CREATE INDEX sim_scenarios_user_idx ON sim_scenarios (user_id, kind, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON sim_scenarios TO kora_app;
GRANT SELECT ON sim_scenarios TO kora_audit_reader;
