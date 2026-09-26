-- 0091 disclosures registry (goal 09): versioned documents per jurisdiction with an effective date,
-- values set by Compliance (NULL = placeholder shown as "[key]"/"[XX]"), publication through four-eyes.
-- Replaces the goal 08 config-backed registry behind the same interface (ADR 0008 §5, ADR 0009).

CREATE TABLE disclosure_documents (
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^([A-Z]{2}|GLOBAL)$'),
  locales jsonb NOT NULL CHECK (jsonb_typeof(locales) = 'object'),
  value_keys text[] NOT NULL DEFAULT '{}',
  simulated boolean NOT NULL,
  review_status text NOT NULL CHECK (length(review_status) BETWEEN 1 AND 64),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  effective_from timestamptz,
  drafted_by text NOT NULL,
  drafted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by text,
  approval_request_id uuid REFERENCES four_eyes_requests (id),
  published_at timestamptz,
  PRIMARY KEY (id, version, jurisdiction),
  CONSTRAINT disclosure_documents_published CHECK (
    status = 'draft' OR (effective_from IS NOT NULL AND published_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT disclosure_documents_four_eyes CHECK (approved_by IS NULL OR approved_by <> drafted_by OR drafted_by = 'system')
);
CREATE INDEX disclosure_documents_in_force_idx ON disclosure_documents (id, jurisdiction, effective_from DESC) WHERE status = 'published';

-- Published text never changes; a draft may only be published (status, dates, approver).
CREATE FUNCTION disclosure_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'published disclosures cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published disclosure %/% is immutable; publish a new version', OLD.id, OLD.version
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.locales <> OLD.locales OR NEW.value_keys <> OLD.value_keys OR NEW.checksum <> OLD.checksum THEN
    RAISE EXCEPTION 'a draft''s text is fixed once drafted; draft a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER disclosure_documents_guard BEFORE UPDATE OR DELETE ON disclosure_documents
  FOR EACH ROW EXECUTE FUNCTION disclosure_documents_guard();

-- Values set by Compliance, per jurisdiction, with their own effective date. Append-only history.
CREATE TABLE disclosure_values (
  key text NOT NULL CHECK (key ~ '^[a-zA-Z]{1,64}$'),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^([A-Z]{2}|GLOBAL)$'),
  effective_from timestamptz NOT NULL,
  value text CHECK (value IS NULL OR length(value) BETWEEN 1 AND 64),
  owner text NOT NULL,
  open_question text,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (key, jurisdiction, effective_from)
);
CREATE TRIGGER disclosure_values_immutable BEFORE UPDATE OR DELETE ON disclosure_values
  FOR EACH ROW EXECUTE FUNCTION governance_block_mutation();

-- The regulatory retail-loss figure stays a placeholder until the Sponsor supplies it (OQ-R1).
INSERT INTO disclosure_values (key, jurisdiction, effective_from, value, owner, open_question, set_by)
VALUES ('retailLossPct', 'GLOBAL', '2026-09-26T00:00:00Z', NULL, 'Sponsor / Compliance', 'OQ-R1', 'system');

-- Acknowledgements remember the jurisdiction whose version was shown (goal 08 rows: GLOBAL).
ALTER TABLE disclosure_acknowledgements ADD COLUMN jurisdiction text NOT NULL DEFAULT 'GLOBAL'
  CHECK (jurisdiction ~ '^([A-Z]{2}|GLOBAL)$');

GRANT SELECT, INSERT, UPDATE ON disclosure_documents TO kora_app;
GRANT SELECT, INSERT ON disclosure_values TO kora_app;
GRANT SELECT ON disclosure_documents, disclosure_values TO kora_audit_reader;
