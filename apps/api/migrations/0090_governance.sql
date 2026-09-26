-- 0090 governance (goal 09): three lines of defence (auditor role + SoD), four-eyes engine, account
-- limit overrides, alert notifications for the risk console, audit visibility (B-303), signed audit
-- anchors (B-007), ITIL 4 incident register, backup/restore evidence, release records.

-- ---------------------------------------------------------------------------
-- 3rd line: the internal auditor role (read-only). SoD: an auditor holds no operating role.
-- ---------------------------------------------------------------------------
ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('novice', 'trader', 'quant', 'risk_officer', 'admin', 'auditor'));

CREATE FUNCTION user_roles_sod() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'auditor' AND EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = NEW.user_id AND role IN ('trader', 'quant', 'risk_officer', 'admin')
  ) THEN
    RAISE EXCEPTION 'segregation of duties: an auditor cannot also hold an operating role' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.role IN ('trader', 'quant', 'risk_officer', 'admin') AND EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = NEW.user_id AND role = 'auditor'
  ) THEN
    RAISE EXCEPTION 'segregation of duties: an auditor cannot also hold an operating role' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_roles_sod BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_sod();

-- ---------------------------------------------------------------------------
-- Four-eyes requests. The approver is never the requester (trigger, for every role incl. owner).
-- Decided rows are immutable; nothing is ever deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE four_eyes_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('limit_override', 'kill_switch_resume', 'mfa_reset', 'disclosure_publish')),
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z_]{1,32}$'),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  requested_by uuid NOT NULL REFERENCES users (id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  decided_by uuid REFERENCES users (id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 3 AND 500),
  result jsonb,
  CONSTRAINT four_eyes_decided_consistent CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT four_eyes_distinct_approver CHECK (
    status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_by <> requested_by)
  )
);
CREATE UNIQUE INDEX four_eyes_one_pending_uq ON four_eyes_requests (kind, subject_id) WHERE status = 'pending';
CREATE INDEX four_eyes_status_idx ON four_eyes_requests (status, requested_at DESC);
CREATE INDEX four_eyes_decided_idx ON four_eyes_requests (decided_at);

CREATE FUNCTION four_eyes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'four_eyes_requests rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'four-eyes request % is already %', OLD.id, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IN ('approved', 'rejected') AND NEW.decided_by = OLD.requested_by THEN
    RAISE EXCEPTION 'four-eyes: the requester cannot approve or reject their own request' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.subject_id <> OLD.subject_id OR NEW.payload <> OLD.payload
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at OR NEW.reason <> OLD.reason THEN
    RAISE EXCEPTION 'four-eyes request content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER four_eyes_requests_guard BEFORE UPDATE OR DELETE ON four_eyes_requests
  FOR EACH ROW EXECUTE FUNCTION four_eyes_guard();

-- ---------------------------------------------------------------------------
-- Per-account limit overrides above the platform default (approved through four-eyes only).
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN limit_overrides jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(limit_overrides) = 'object');

-- ---------------------------------------------------------------------------
-- Alerts reach the risk console: NOTIFY on commit (the api relays to the WS channel risk:alerts).
-- ---------------------------------------------------------------------------
CREATE FUNCTION alerts_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('kora_alerts', NEW.id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER alerts_notify AFTER INSERT ON alerts FOR EACH ROW EXECUTE FUNCTION alerts_notify();
CREATE INDEX alerts_kind_idx ON alerts (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- B-303: owners read system-actor events about their own account (payload.accountId).
-- ---------------------------------------------------------------------------
CREATE INDEX audit_events_account_idx ON audit_events ((payload->>'accountId'), id) WHERE payload ? 'accountId';

-- ---------------------------------------------------------------------------
-- B-007: signed anchors of the audit head (daily digest; also appended to a WORM directory).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_anchors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  head_id bigint NOT NULL CHECK (head_id >= 0),
  head_hash char(64) NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  event_count bigint NOT NULL CHECK (event_count >= 0),
  algorithm text NOT NULL CHECK (algorithm IN ('ES256')),
  key_id text NOT NULL,
  public_jwk jsonb NOT NULL,
  signature text NOT NULL,
  created_by text NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_anchors_at_idx ON audit_anchors (anchored_at DESC);

CREATE FUNCTION governance_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (goal 09): rows cannot be changed or deleted', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_anchors_immutable BEFORE UPDATE OR DELETE ON audit_anchors
  FOR EACH ROW EXECUTE FUNCTION governance_block_mutation();

-- ---------------------------------------------------------------------------
-- ITIL 4 incident register: detect → log → classify → resolve → post-incident review.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE incident_ref_seq;
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE DEFAULT ('INC-' || lpad(nextval('incident_ref_seq')::text, 6, '0')),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  description text NOT NULL CHECK (length(description) BETWEEN 3 AND 4000),
  category text NOT NULL CHECK (category IN ('feed_outage', 'engine_stall', 'reconciliation_break', 'ai_provider_outage',
    'kill_switch_fired', 'database_restore', 'security', 'other')),
  exercise boolean NOT NULL DEFAULT false,
  alert_id uuid REFERENCES alerts (id),
  status text NOT NULL DEFAULT 'logged' CHECK (status IN ('logged', 'classified', 'resolved', 'closed')),
  impact text CHECK (impact IN ('high', 'medium', 'low')),
  urgency text CHECK (urgency IN ('high', 'medium', 'low')),
  priority text CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
  resolution text,
  review_ref text,
  detected_at timestamptz NOT NULL,
  logged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  logged_by uuid NOT NULL REFERENCES users (id),
  classified_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT incidents_classified CHECK (status = 'logged' OR priority IS NOT NULL),
  CONSTRAINT incidents_resolved CHECK (status NOT IN ('resolved', 'closed') OR resolution IS NOT NULL),
  CONSTRAINT incidents_review CHECK (status <> 'closed' OR priority NOT IN ('P1', 'P2') OR review_ref IS NOT NULL)
);
ALTER SEQUENCE incident_ref_seq OWNED BY incidents.ref;
CREATE INDEX incidents_status_idx ON incidents (status, logged_at DESC);
CREATE TRIGGER incidents_no_delete BEFORE DELETE ON incidents
  FOR EACH ROW EXECUTE FUNCTION governance_block_mutation();

-- ---------------------------------------------------------------------------
-- Backup and restore evidence (scripts/backup.sh writes one row per backup and restore test).
-- ---------------------------------------------------------------------------
CREATE TABLE backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('backup', 'restore_test')),
  database text NOT NULL,
  ok boolean NOT NULL,
  artefact text,
  bytes bigint CHECK (bytes IS NULL OR bytes >= 0),
  sha256 char(64),
  tables_checked integer,
  rows_checked bigint,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_by text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX backup_runs_finished_idx ON backup_runs (finished_at DESC);
CREATE TRIGGER backup_runs_immutable BEFORE UPDATE OR DELETE ON backup_runs
  FOR EACH ROW EXECUTE FUNCTION governance_block_mutation();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON four_eyes_requests, incidents TO kora_app;
GRANT SELECT, INSERT ON audit_anchors, backup_runs TO kora_app;
GRANT USAGE ON SEQUENCE incident_ref_seq TO kora_app;
-- Change-management evidence reads the migration ledger (read-only).
GRANT SELECT ON schema_migrations TO kora_app, kora_audit_reader;
GRANT SELECT ON four_eyes_requests, incidents, audit_anchors, backup_runs, alerts, reconciliation_runs TO kora_audit_reader;
