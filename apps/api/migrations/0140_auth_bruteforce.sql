-- 0140 brute-force protection of sign-in (IRTC R1-01, R1-04, R1-07).
-- Policy: docs/open-questions.md OQ-R1-1 (Product Owner, delegated Sponsor authority).
--
-- 1. Second factor (TOTP, recovery code, step-up) failures get their own counter. Only a successful
--    second factor resets it; a correct password never does (R1-01). `users.locked_until` now means
--    "second factor locked until" and `mfa_lock_count` doubles each renewal of that lock.
-- 2. The password step no longer hard-locks an account (R1-04: it let anyone lock a known account
--    and the distinct answer revealed which accounts exist). It uses progressive back-off keyed on
--    hashes of (e-mail, IP) and of the e-mail alone, so an unknown e-mail behaves exactly like an
--    existing one. Keys are SHA-256 hashes: no clear e-mail of a non-user is stored.
-- 3. Addresses a user completed a full sign-in from ("known IPs", hashed) are exempt from the
--    account-wide back-off, so a distributed attack cannot lock the owner out of their usual device.

ALTER TABLE users
  ADD COLUMN mfa_failed_count integer NOT NULL DEFAULT 0 CHECK (mfa_failed_count >= 0),
  ADD COLUMN mfa_lock_count integer NOT NULL DEFAULT 0 CHECK (mfa_lock_count >= 0);

COMMENT ON COLUMN users.locked_until IS 'Second factor locked until (IRTC R1-01). The password step never hard-locks (R1-04).';
COMMENT ON COLUMN users.failed_logins IS 'Informational count of wrong passwords since the last correct one (no lock).';

CREATE TABLE auth_login_backoff (
  scope text NOT NULL CHECK (scope IN ('pair', 'account')),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_failure_at timestamptz NOT NULL,
  blocked_until timestamptz,
  PRIMARY KEY (scope, key_hash)
);
CREATE INDEX auth_login_backoff_last_idx ON auth_login_backoff (last_failure_at);

CREATE TABLE auth_known_ips (
  user_id uuid NOT NULL REFERENCES users (id),
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  last_success_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, ip_hash)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_login_backoff TO kora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_known_ips TO kora_app;
