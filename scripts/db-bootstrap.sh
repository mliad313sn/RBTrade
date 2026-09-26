#!/usr/bin/env bash
# Idempotent cluster bootstrap: roles + databases. Uses libpq env (PGHOST, PGPORT, PGUSER=superuser).
# Shared by scripts/dev-db.sh, CI and infra/postgres/init (compose).
set -euo pipefail
: "${KORA_DB_OWNER_PASSWORD:?}" "${KORA_DB_APP_PASSWORD:?}" "${KORA_DB_AUDIT_READER_PASSWORD:?}"
PSQL="${PSQL:-psql}"
DBS="${KORA_DATABASES:-kora kora_test kora_e2e}"

"$PSQL" -v ON_ERROR_STOP=1 -q \
  -v owner_pw="$KORA_DB_OWNER_PASSWORD" -v app_pw="$KORA_DB_APP_PASSWORD" -v reader_pw="$KORA_DB_AUDIT_READER_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE kora_owner LOGIN PASSWORD %L', :'owner_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kora_owner') \gexec
SELECT format('CREATE ROLE kora_app LOGIN PASSWORD %L', :'app_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kora_app') \gexec
SELECT format('CREATE ROLE kora_audit_reader LOGIN PASSWORD %L', :'reader_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kora_audit_reader') \gexec
-- keep passwords in sync with env on every run
SELECT format('ALTER ROLE kora_owner PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE kora_app PASSWORD %L', :'app_pw') \gexec
SELECT format('ALTER ROLE kora_audit_reader PASSWORD %L', :'reader_pw') \gexec
ALTER ROLE kora_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE kora_audit_reader NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SQL

for db in $DBS; do
  "$PSQL" -v ON_ERROR_STOP=1 -q -tc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 \
    || "$PSQL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$db\" OWNER kora_owner"
  "$PSQL" -v ON_ERROR_STOP=1 -q -d "$db" <<SQL
REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
GRANT CONNECT ON DATABASE "$db" TO kora_owner, kora_app, kora_audit_reader;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO kora_owner;
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS timescaledb;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'timescaledb available but not loadable (%); continuing on plain Postgres', SQLERRM;
    END;
  END IF;
END \$\$;
SQL
done
echo "[db-bootstrap] roles and databases ready: $DBS"
