# ADR 0000 — Development and test environment

- Status: Accepted (2026-09-26)
- Deciders: Project Owner, S3 (architect), S9 (security), S10 (QA)

## Context

The master goal's definition of done is `pnpm i && docker compose up -d && pnpm dev`. The cloud sessions that build KORA have **no Docker daemon**. They do have:

- PostgreSQL 16 binaries at `/usr/lib/postgresql/16/bin` (`initdb`, `pg_ctl`, `psql`);
- `redis-server` 7;
- Node 22, pnpm 10, Python **3.11** (the master goal names 3.12);
- Playwright Chromium at `/opt/pw-browsers` (revision 1194, which matches `@playwright/test` 1.56.x);
- no Keycloak.

## Decision

1. **Native services for dev and test.** `scripts/dev-db.sh start|stop|status|reset` runs:
   - a Postgres cluster under `.data/pg` on port `55432`;
   - Redis under `.data/redis` on port `56379`.

   `.data/` is git-ignored. When the script runs as root it runs Postgres as the `postgres` OS user, because `initdb` refuses root. It then runs `scripts/db-bootstrap.sh`, which creates the database roles and databases (`kora`, `kora_test`). `pnpm dev` calls `dev-db.sh start` first, so it works without Docker.
2. **docker-compose is the deployment reference.** `infra/docker-compose.yml` defines Postgres 16 + TimescaleDB, Redis 7, Keycloak, OTel collector, Prometheus and Grafana, with the **same** role bootstrap (`infra/postgres/init`). Tests must never require it. With Docker available, `docker compose -f infra/docker-compose.yml up -d` followed by `pnpm dev:apps` is the documented path.
3. **Ports.** Native dev uses 55432/56379 so it does not collide with a system Postgres or Redis. Compose publishes the standard 5432/6379. Every URL comes from `.env` (see `.env.example`).
4. **Python compatibility.** `services/quant` declares `requires-python = ">=3.11"`. ruff targets `py311` and mypy runs `--strict` with `python_version = 3.11`. CI tests both 3.11 and 3.12. No 3.12-only syntax (PEP 695 generics, `type` statements).
5. **Browsers.** Playwright is pinned to 1.56.1 so it uses the preinstalled Chromium 1194. Set `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. CI runs `playwright install --with-deps chromium`.
6. **CI** uses GitHub Actions service containers (`timescale/timescaledb:2.17.2-pg16`, `redis:7`) and runs the same bootstrap and migration scripts.

## Consequences

- Tests hit a real Postgres (no mocks for SQL), so the insert-only role and audit tamper tests are meaningful.
- Anything that needs Docker locally (Trivy image scan, the Keycloak e2e, the Grafana dashboards) is verified only in CI or in a Docker environment. Plans mark these *deferred with reason*.
- Developers who have Docker can use either path. The env var names are the same.
