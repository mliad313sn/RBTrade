#!/usr/bin/env bash
# Native Postgres 16 + Redis 7 for dev/test without Docker (ADR 0000).
# Usage: scripts/dev-db.sh start|stop|status|reset
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] || { cp .env.example .env; echo "[dev-db] created .env from .env.example"; }
set -a; # shellcheck disable=SC1091
source .env; set +a

# Generate stable local dev keys once (kept only in the git-ignored .env) so sessions survive API restarts.
if [ "${KORA_ENV:-dev}" = "dev" ]; then
  node "$ROOT/scripts/gen-dev-secrets.mjs" "$ROOT/.env"
  set -a; # shellcheck disable=SC1091
  source .env; set +a
fi

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_PORT="${KORA_PG_PORT:-55432}"
REDIS_PORT="${KORA_REDIS_PORT:-56379}"
DATA="$ROOT/.data"
PGDATA="$DATA/pg"
PGSOCK="$DATA/pg-sock"
PGLOG="$DATA/pg.log"
REDIS_DIR="$DATA/redis"

as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

pg_running() { as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }
redis_running() { redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; }

start_pg() {
  mkdir -p "$DATA" "$PGSOCK"
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "[dev-db] initdb $PGDATA"
    mkdir -p "$PGDATA"
    local pwfile="$DATA/.pgpw"
    printf '%s\n' "${KORA_PG_SUPERUSER_PASSWORD:?set KORA_PG_SUPERUSER_PASSWORD}" >"$pwfile"
    if [ "$(id -u)" = "0" ]; then chown -R postgres:postgres "$PGDATA" "$PGSOCK" "$pwfile"; fi
    as_pg "$PG_BIN/initdb" -D "$PGDATA" -U postgres --pwfile="$pwfile" \
      --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 >/dev/null
    rm -f "$pwfile"
  fi
  if [ "$(id -u)" = "0" ]; then chown postgres:postgres "$PGSOCK"; touch "$PGLOG"; chown postgres "$PGLOG"; fi
  if pg_running; then
    echo "[dev-db] postgres already running on $PG_PORT"
  else
    as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGLOG" -w -t 30 \
      -o "-p $PG_PORT -k $PGSOCK -c listen_addresses=127.0.0.1 -c timezone=UTC -c log_timezone=UTC" start >/dev/null
    echo "[dev-db] postgres started on 127.0.0.1:$PG_PORT"
  fi
  PGHOST="$PGSOCK" PGPORT="$PG_PORT" PGUSER=postgres PGDATABASE=postgres bash "$ROOT/scripts/db-bootstrap.sh"
}

start_redis() {
  mkdir -p "$REDIS_DIR"
  if redis_running; then
    echo "[dev-db] redis already running on $REDIS_PORT"
  else
    redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$REDIS_DIR" --daemonize yes \
      --pidfile "$REDIS_DIR/redis.pid" --logfile "$REDIS_DIR/redis.log" --save "" --appendonly no >/dev/null
    for _ in $(seq 1 50); do redis_running && break; sleep 0.1; done
    echo "[dev-db] redis started on 127.0.0.1:$REDIS_PORT"
  fi
}

stop_all() {
  if pg_running; then as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null && echo "[dev-db] postgres stopped"; fi
  if redis_running; then redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true; echo "[dev-db] redis stopped"; fi
}

case "${1:-start}" in
  start) start_pg; start_redis ;;
  stop) stop_all ;;
  status)
    pg_running && echo "postgres: running ($PG_PORT)" || echo "postgres: stopped"
    redis_running && echo "redis: running ($REDIS_PORT)" || echo "redis: stopped"
    ;;
  reset) stop_all; rm -rf "$PGDATA" "$REDIS_DIR" "$PGSOCK"; start_pg; start_redis ;;
  *) echo "usage: $0 start|stop|status|reset" >&2; exit 2 ;;
esac
