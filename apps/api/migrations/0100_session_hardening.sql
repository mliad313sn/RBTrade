-- 0100 session and MFA hardening (goal 10, S9).
-- 1. Server-side session revocation (B-002 part): logout revokes the token id until it expires;
--    role changes, MFA resets and disabling a user invalidate every older token of that user.
-- 2. MFA recovery codes (B-902): one-time, stored as SHA-256 of a high-entropy code, never in clear.

ALTER TABLE users ADD COLUMN sessions_valid_after timestamptz;

CREATE TABLE revoked_tokens (
  jti text PRIMARY KEY CHECK (length(jti) BETWEEN 8 AND 128),
  user_id uuid NOT NULL REFERENCES users (id),
  reason text NOT NULL CHECK (reason IN ('logout', 'admin')),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX revoked_tokens_expires_idx ON revoked_tokens (expires_at);

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  batch uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

GRANT SELECT, INSERT, DELETE ON revoked_tokens TO kora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO kora_app;
