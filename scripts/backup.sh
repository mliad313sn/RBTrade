#!/usr/bin/env bash
# Backup and restore test (goal 09, control KC-26; runbook docs/runbooks/database-restore.md).
#
#   scripts/backup.sh [--db kora] [--dir .data/backups] [--no-restore-test]
#
# 1. pg_dump (custom format) of the database → <dir>/<db>-<utc>.dump, SHA-256 recorded.
# 2. Restore test: the dump is restored into a scratch database (<db>_restore_test, recreated each
#    time), then row counts of the key tables and the audit head (id + hash) are compared with the
#    source. Nothing touches the source database except two evidence rows in `backup_runs`.
# 3. Both results are written to `backup_runs` in the source database (evidence for KC-26).
#
# Env (from .env): DATABASE_URL_MIGRATE (owner of the source DB), KORA_PG_PORT, KORA_PG_SUPERUSER_PASSWORD
# or KORA_BACKUP_ADMIN_URL (a role that may create/drop the scratch database and restore it).
# Production uses managed backups / PITR; this script is the dev/staging equivalent and the
# restore-test procedure. It never runs against LIVE data from this repository.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && { set -a; # shellcheck disable=SC1091
  source .env; set +a; }

DB="kora"
DIR="$ROOT/.data/backups"
RESTORE_TEST=1
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --no-restore-test) RESTORE_TEST=0; shift ;;
    *) echo "usage: $0 [--db kora] [--dir path] [--no-restore-test]" >&2; exit 2 ;;
  esac
done

PORT="${KORA_PG_PORT:-55432}"
ADMIN_URL="${KORA_BACKUP_ADMIN_URL:-postgres://postgres:${KORA_PG_SUPERUSER_PASSWORD:-}@127.0.0.1:${PORT}/postgres}"
OWNER_URL="$(echo "${DATABASE_URL_MIGRATE:?DATABASE_URL_MIGRATE is required}" | sed -E "s#/[^/?]+(\?|$)#/${DB}\1#")"
SRC_URL="$(echo "$ADMIN_URL" | sed -E "s#/[^/?]+(\?|$)#/${DB}\1#")"
SCRATCH="${DB}_restore_test"
SCRATCH_URL="$(echo "$ADMIN_URL" | sed -E "s#/[^/?]+(\?|$)#/${SCRATCH}\1#")"
BY="${KORA_BACKUP_RECORDED_BY:-scripts/backup.sh@$(hostname)}"

mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/${DB}-${STAMP}.dump"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

record() { # kind ok artefact bytes sha tables rows detail started
  psql "$OWNER_URL" -v ON_ERROR_STOP=1 -qAt \
    -v kind="$1" -v ok="$2" -v artefact="$3" -v bytes="$4" -v sha="$5" -v tables="$6" -v rows="$7" -v detail="$8" -v started="$9" -v db="$DB" -v by="$BY" <<'SQL'
INSERT INTO backup_runs (kind, database, ok, artefact, bytes, sha256, tables_checked, rows_checked, detail, recorded_by, started_at)
VALUES (:'kind', :'db', :'ok'::boolean, NULLIF(:'artefact', ''), NULLIF(:'bytes', '')::bigint, NULLIF(:'sha', ''),
        NULLIF(:'tables', '')::int, NULLIF(:'rows', '')::bigint, :'detail'::jsonb, :'by', :'started'::timestamptz)
RETURNING id;
SQL
}

echo "[backup] dumping ${DB} → ${FILE}"
pg_dump --format=custom --no-password --file="$FILE" "$SRC_URL"
chmod 600 "$FILE"
BYTES="$(stat -c %s "$FILE")"
SHA="$(sha256sum "$FILE" | cut -d' ' -f1)"
ID="$(record backup true "$FILE" "$BYTES" "$SHA" '' '' "{\"format\":\"custom\",\"tool\":\"pg_dump\"}" "$START")"
echo "[backup] ok: ${BYTES} bytes, sha256 ${SHA} (backup_runs ${ID})"

[ "$RESTORE_TEST" = "1" ] || exit 0

RSTART="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[restore-test] restoring into ${SCRATCH}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS ${SCRATCH}" -c "CREATE DATABASE ${SCRATCH}"
pg_restore --no-password --exit-on-error --dbname="$SCRATCH_URL" "$FILE"

TABLES="users user_roles accounts orders fills positions ledger_entries audit_events disclosure_acknowledgements four_eyes_requests incidents"
count_sql=""
for t in $TABLES; do count_sql="${count_sql}SELECT '${t}', count(*) FROM ${t} UNION ALL "; done
count_sql="${count_sql}SELECT 'audit_head', coalesce((SELECT id FROM audit_events ORDER BY id DESC LIMIT 1), 0)"
SRC_COUNTS="$(psql "$SRC_URL" -qAt -F= -c "$count_sql")"
DST_COUNTS="$(psql "$SCRATCH_URL" -qAt -F= -c "$count_sql")"
HEAD_SQL="SELECT coalesce((SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1), '')"
SRC_HEAD="$(psql "$SRC_URL" -qAt -c "$HEAD_SQL")"
DST_HEAD="$(psql "$SCRATCH_URL" -qAt -c "$HEAD_SQL")"

OK=true
ROWS=0
N=0
DETAIL="{"
while IFS='=' read -r name src; do
  dst="$(echo "$DST_COUNTS" | grep "^${name}=" | cut -d= -f2)"
  # Rows written to the source after the dump (e.g. this script's own evidence row) are allowed.
  if [ "$name" != "audit_head" ] && [ "${dst:-x}" != "$src" ] && [ "$name" != "audit_events" ]; then OK=false; fi
  [ "$name" = "audit_head" ] || { ROWS=$((ROWS + ${dst:-0})); N=$((N + 1)); }
  DETAIL="${DETAIL}\"${name}\":{\"source\":${src},\"restored\":${dst:-null}},"
done <<< "$SRC_COUNTS"
# The restored audit chain must be a prefix of the source chain (its head hash exists in the source).
if [ -n "$DST_HEAD" ]; then
  IN_SRC="$(psql "$SRC_URL" -qAt -c "SELECT count(*) FROM audit_events WHERE hash = '${DST_HEAD}'")"
  [ "$IN_SRC" = "1" ] || OK=false
fi
DETAIL="${DETAIL}\"restoredAuditHead\":\"${DST_HEAD}\",\"sourceAuditHead\":\"${SRC_HEAD}\",\"scratchDatabase\":\"${SCRATCH}\"}"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS ${SCRATCH}"
RID="$(record restore_test "$OK" "$FILE" "$BYTES" "$SHA" "$N" "$ROWS" "$DETAIL" "$RSTART")"
echo "[restore-test] ${OK}: ${N} tables, ${ROWS} rows compared, restored audit head ${DST_HEAD:0:16}… (backup_runs ${RID})"
[ "$OK" = "true" ]
