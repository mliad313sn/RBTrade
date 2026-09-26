-- Goal 08: Novice view. Curated novice assets in the registry, monthly equity snapshots (monthly
-- loss limit), disclosure acknowledgements (versioned; goal 09's disclosures registry will own the
-- documents), novice onboarding state, and template robots for novices (B-614). PAPER only.

-- ---------------------------------------------------------------------------
-- Registry: curated novice list (about 10 instruments, all continents). Changing the list is a
-- registry update, not a code change. Names are required in every supported language.
-- ---------------------------------------------------------------------------
ALTER TABLE instruments
  ADD COLUMN novice_rank smallint CHECK (novice_rank BETWEEN 1 AND 100),
  ADD COLUMN novice_name jsonb CHECK (
    novice_name IS NULL OR (
      jsonb_typeof(novice_name) = 'object'
      AND length(coalesce(novice_name ->> 'en', '')) BETWEEN 1 AND 40
      AND length(coalesce(novice_name ->> 'fr', '')) BETWEEN 1 AND 40
    )
  ),
  ADD CONSTRAINT instruments_novice_named CHECK (novice_rank IS NULL OR novice_name IS NOT NULL);
CREATE UNIQUE INDEX instruments_novice_rank_uq ON instruments (novice_rank) WHERE novice_rank IS NOT NULL;

UPDATE instruments AS i SET novice_rank = v.rank, novice_name = v.name::jsonb
FROM (VALUES
  ('EURUSD', 1, '{"en": "Euro vs Dollar", "fr": "Euro contre dollar"}'),
  ('XAUUSD', 2, '{"en": "Gold", "fr": "Or"}'),
  ('AAPL', 3, '{"en": "Apple shares", "fr": "Actions Apple"}'),
  ('BTCUSD', 4, '{"en": "Bitcoin", "fr": "Bitcoin"}'),
  ('SPY', 5, '{"en": "US top 500 fund", "fr": "Fonds 500 US"}'),
  ('KGEF', 6, '{"en": "World shares fund", "fr": "Fonds actions monde"}'),
  ('SAP.XETR', 7, '{"en": "SAP shares", "fr": "Actions SAP"}'),
  ('7203.XTKS', 8, '{"en": "Toyota shares", "fr": "Actions Toyota"}'),
  ('BHP.XASX', 9, '{"en": "BHP shares", "fr": "Actions BHP"}'),
  ('NPN.XJSE', 10, '{"en": "Naspers shares", "fr": "Actions Naspers"}')
) AS v(symbol, rank, name)
WHERE i.symbol = v.symbol;

-- ---------------------------------------------------------------------------
-- Monthly loss limit: month-start equity snapshots next to day and week.
-- ---------------------------------------------------------------------------
ALTER TABLE account_equity_snapshots DROP CONSTRAINT account_equity_snapshots_period_check;
ALTER TABLE account_equity_snapshots
  ADD CONSTRAINT account_equity_snapshots_period_check CHECK (period IN ('day', 'week', 'month'));

-- ---------------------------------------------------------------------------
-- Disclosure acknowledgements: append-only, bound to the exact version and content hash shown
-- (including the Compliance-set figure that was rendered, e.g. the retail-loss percentage).
-- ---------------------------------------------------------------------------
CREATE TABLE disclosure_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  disclosure_id text NOT NULL CHECK (disclosure_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  rendered_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rendered_values) = 'object'),
  context text NOT NULL DEFAULT 'onboarding' CHECK (context IN ('onboarding', 'banner', 'settings', 'reconfirm')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX disclosure_acknowledgements_user_idx ON disclosure_acknowledgements (user_id, disclosure_id, created_at DESC);

CREATE FUNCTION novice_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (goal 08): rows cannot be changed or deleted', TG_TABLE_NAME;
END $$;
CREATE TRIGGER disclosure_acknowledgements_immutable BEFORE UPDATE OR DELETE ON disclosure_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION novice_block_mutation();

-- ---------------------------------------------------------------------------
-- Novice onboarding state (the explainer, disclosure and limits steps are checked server-side).
-- ---------------------------------------------------------------------------
CREATE TABLE novice_profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  onboarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Template robots for novices (B-614): created only through the guarded /novice/auto-invest path.
-- ---------------------------------------------------------------------------
ALTER TABLE robots
  ADD COLUMN origin text NOT NULL DEFAULT 'builder' CHECK (origin IN ('builder', 'novice_template')),
  ADD COLUMN template_id text CHECK (template_id IS NULL OR template_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT robots_template_origin CHECK ((origin = 'novice_template') = (template_id IS NOT NULL));

GRANT SELECT, INSERT ON disclosure_acknowledgements TO kora_app;
REVOKE UPDATE, DELETE, TRUNCATE ON disclosure_acknowledgements FROM kora_app;
GRANT SELECT, INSERT, UPDATE ON novice_profiles TO kora_app;
GRANT SELECT ON disclosure_acknowledgements, novice_profiles TO kora_audit_reader;
