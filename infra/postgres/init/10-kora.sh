#!/usr/bin/env bash
# Runs once on first container start (docker-entrypoint-initdb.d): same bootstrap as native dev.
set -euo pipefail
export PGUSER="${POSTGRES_USER:-postgres}" PGDATABASE=postgres
bash /kora/db-bootstrap.sh
