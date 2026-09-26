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
pnpm --filter @kora/api build && pnpm --filter @kora/api load:ws   # WebSocket fan-out load test (goal 02)
```

## Market data (goal 02, all SIMULATED)

- The api runs a deterministic simulated feed in-process (`KORA_MD_FEED=inprocess`). Or run it standalone: `KORA_MD_FEED=off` plus `pnpm --filter @kora/api md:feed`.
- REST: `/instruments`, `/venues`, `/candles?symbol=EURUSD&tf=15m&limit=500`, `/quotes?symbols=…`, `/depth/:symbol`, `/calendar`, `/market-data/status`.
- WebSocket: `ws://<host>:4000/ws`, with channels `quotes:{symbol}`, `depth:{symbol}`, `candles:{symbol}:{tf}` and `status`. Use `MarketDataSocket` from `@kora/sdk`.
- Design: ADR 0002. Results: `docs/plans/02-market-data.md`.

## Trading core (goal 03, PAPER only)

- Everyone signs up as `novice`. Pro trading (`trader`) needs the appropriateness assessment (`/appropriateness` in the web, `GET /appropriateness/questionnaire` + `POST /appropriateness/attempts`), then TOTP enrolment at the next login.
- Paper account per user (base currency, SIMULATED starting cash): `GET /accounts/me`, `PUT /accounts/me/settings`, `GET /accounts/me/ledger`.
- Orders: `POST /orders/preview` (notional, fees + spread, FX conversion, margin, loss if the stop is hit, reward:risk, risk verdict), `POST /orders` (idempotent on `clientOrderId`), `GET/PATCH/DELETE /orders/:id`, `GET /positions`, `POST /positions/:symbol/close`, `GET /fills`.
- Kill switch: `POST /kill-switch {scope, source, reason?}`, `POST /kill-switch/resume {reason}`, `GET /kill-switch`. Reconciliation: `POST /reconciliation/run`, alerts at `GET /alerts`.
- WebSocket private channels: `orders:{accountId}`, `positions:{accountId}`, `account:{accountId}`.
- `LIVE_TRADING_ENABLED` stays `false`; the LIVE broker is a refusing stub. Design: ADR 0003. Results: `docs/plans/03-oms.md`.

## Pro terminal (goal 04)

- `/terminal`: dockable panels (dockview): watchlists, chart (lightweight-charts, indicators from `@kora/domain`), order book, time and sales, the full ticket, and a streaming blotter (Positions, Orders, Fills, Alerts, Risk). The default layout follows `design/prototype/Main.png`. Named layouts are saved per user (`/me/layouts`); "Reset to default" rebuilds the grid.
- ⌘K / Ctrl+K opens the palette: every registry instrument, grouped by region and asset class, plus actions. Press `?` for the hotkey cheat sheet; change the bindings in Settings.
- API: `/me/layouts`, `/me/watchlists`, `/price-alerts` (evaluated by the server), `GET /risk/summary`, `DELETE /orders?symbol=` (cancel all). WebSocket: `trades:{symbol}` (time and sales).
- Design: ADR 0004. Results and evidence: `docs/plans/04-pro-terminal.md`.

## Layout

```
apps/web  apps/api  services/quant  services/bot-runner
packages/ui  packages/domain  packages/sdk  packages/config  packages/market-data
infra/  scripts/  docs/ (goals, plans, ADRs, STATUS, BACKLOG, open questions)
```
