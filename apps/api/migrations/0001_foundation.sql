-- 0001 foundation: identity, preferences, append-only hash-chained audit log.
-- Runs as kora_owner. Plain Postgres (TimescaleDB optional, not used here).
-- Convention: every migration GRANTs explicitly to kora_app / kora_audit_reader.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text,                       -- NULL for externally managed identities (Keycloak)
  identity_provider text NOT NULL DEFAULT 'dev' CHECK (identity_provider IN ('dev', 'keycloak')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_len CHECK (char_length(email) BETWEEN 3 AND 320)
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('novice', 'trader', 'quant', 'risk_officer', 'admin')),
  granted_by uuid REFERENCES users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  totp_secret_enc text NOT NULL,            -- AES-256-GCM (KORA_MFA_ENC_KEY), never plaintext
  enabled_at timestamptz,                   -- NULL = enrolment pending
  last_used_step bigint,                    -- replay protection
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  view_mode text NOT NULL DEFAULT 'pro' CHECK (view_mode IN ('pro', 'novice')),
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'pro-dark', 'novice-light')),
  colour_convention text NOT NULL DEFAULT 'blue_orange'
    CHECK (colour_convention IN ('blue_orange', 'green_red', 'red_up_asia')),
  hotkeys jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(hotkeys) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit log (ADR 0102). id is assigned by AuditService under an advisory lock
-- (last id + 1), so a rolled-back transaction never leaves a gap in the chain.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id bigint PRIMARY KEY CHECK (id > 0),
  ts timestamptz NOT NULL,
  actor_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'robot', 'ai', 'system')),
  action text NOT NULL CHECK (action ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  entity text NOT NULL,
  entity_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash char(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash char(64) NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, id);
CREATE INDEX audit_events_entity_idx ON audit_events (entity, entity_id, id);
CREATE INDEX audit_events_action_idx ON audit_events (action, id);
CREATE INDEX audit_events_ts_idx ON audit_events (ts);

CREATE FUNCTION audit_events_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_block_mutation();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kora_app, kora_audit_reader;

GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_roles, user_mfa, user_preferences TO kora_app;

-- Insert-only for the runtime role: UPDATE / DELETE / TRUNCATE revoked at role level.
REVOKE ALL ON audit_events FROM kora_app;
GRANT SELECT, INSERT ON audit_events TO kora_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_events FROM kora_app;

GRANT SELECT ON audit_events TO kora_audit_reader;
