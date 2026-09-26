# KORA

KORA is a trading platform with four modules on one account: a Pro terminal, a gain simulator, a robot trader and a novice view.

It runs on **paper money only**. `LIVE_TRADING_ENABLED=false` is enforced at boot.

Read `CLAUDE.md`, `docs/goal/00-MASTER-GOAL.md`, `docs/governance/CHARTER.md` and `docs/STATUS.md` first.

## Quick start (no Docker needed)

```bash
pnpm i
pnpm dev
```

`pnpm dev` does three things:

1. Starts native Postgres 16 and Redis 7 via `scripts/dev-db.sh`.
2. Runs the migrations.
3. Starts web, api, quant and bot-runner.

| Service | URL |
|---|---|
| web | http://localhost:3000 (sign up, then set up two-factor if you pick "Pro trader") |
| api | http://localhost:4000/health, docs at `/docs` |
| quant | http://localhost:8000/health |
| bot-runner | http://localhost:4100/health |

With Docker, run `docker compose up -d` (reference stack: Timescale, Redis, Keycloak, OTel, Prometheus, Grafana), then `pnpm dev:apps`. See ADR 0000.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test          # all packages, Python included
pnpm contrast                                      # WCAG text contrast, both themes
pnpm --filter @kora/api test:integration           # real Postgres + Redis
pnpm --filter @kora/ui build-storybook && pnpm --filter @kora/ui test:storybook-axe
pnpm build && pnpm test:e2e                        # Playwright (PLAYWRIGHT_BROWSERS_PATH from .env)
```

## Layout

```
apps/web  apps/api  services/quant  services/bot-runner
packages/ui  packages/domain  packages/sdk  packages/config
infra/  scripts/  docs/ (goals, plans, ADRs, STATUS, BACKLOG, open questions)
```
