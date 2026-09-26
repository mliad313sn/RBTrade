-- 0004 questionnaire engine (B-018, ADR 0003 §appropriateness): versioned questionnaire definitions
-- (appropriateness now; knowledge checks and suitability in goals 08/09) and graded attempts.
-- Definitions are reviewed data files synced at boot; a published version is immutable.
-- Attempts store the score only, never the answers (data minimisation).

CREATE TABLE questionnaires (
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  version integer NOT NULL CHECK (version >= 1),
  kind text NOT NULL CHECK (kind IN ('appropriateness', 'knowledge_check', 'suitability')),
  title text NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  simulated boolean NOT NULL,
  review_status text NOT NULL CHECK (review_status IN ('placeholder_pending_compliance_review', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE FUNCTION questionnaires_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'questionnaire versions are immutable: publish a new version instead' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER questionnaires_no_update BEFORE UPDATE OR DELETE ON questionnaires
  FOR EACH ROW EXECUTE FUNCTION questionnaires_immutable();

CREATE TABLE questionnaire_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  questionnaire_id text NOT NULL,
  version integer NOT NULL,
  score integer NOT NULL CHECK (score >= 0),
  max_score integer NOT NULL CHECK (max_score > 0),
  score_pct integer NOT NULL CHECK (score_pct BETWEEN 0 AND 100),
  pass_mark_pct integer NOT NULL CHECK (pass_mark_pct BETWEEN 0 AND 100),
  passed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (questionnaire_id, version) REFERENCES questionnaires (id, version)
);
CREATE INDEX questionnaire_attempts_user_idx ON questionnaire_attempts (user_id, questionnaire_id, created_at DESC);

GRANT SELECT, INSERT ON questionnaires, questionnaire_attempts TO kora_app;
REVOKE UPDATE, DELETE, TRUNCATE ON questionnaires, questionnaire_attempts FROM kora_app;
GRANT SELECT ON questionnaires, questionnaire_attempts TO kora_audit_reader;
