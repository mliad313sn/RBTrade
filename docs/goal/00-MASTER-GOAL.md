# /goal 00 — KORA Trading Platform · Master goal (read first, always)

> Paste this as the first /goal of the project, then save it as `docs/goal/00-master.md` and reference it from `CLAUDE.md`. Every module prompt (01–10) assumes this file is loaded.

## Mission
Build **KORA**, a production-grade web trading platform with four modules sharing one account, one instrument registry and one audit trail:

1. **Pro Terminal**: professional multi-asset trading screen.
2. **Gain Simulator**: Monte Carlo projection and paper trading.
3. **AI Robot Trader**: strategy builder, backtester and live bot runner, with an AI copilot.
4. **Novice view**: a simplified, guard-railed experience for non-experts (desktop and mobile).

The Design canvas "KORA Trading Platform Prototype" (6 artboards) is the visual and functional reference. Export it into `/design/prototype/` and match its layout, tokens and behaviours unless a module prompt says otherwise.

## Non-negotiable principles (from the design committee)
- **Paper first.** Every environment starts in PAPER mode. LIVE trading sits behind the feature flag `LIVE_TRADING_ENABLED=false`. It needs a broker adapter, a compliance sign-off record and 2FA per session. Never enable it in code by default.
- **No hidden risk.** Every order preview shows the estimated cost, fees, margin impact and loss if the stop is hit. Every projection shows a distribution (P5–P95), never a single line.
- **AI suggests, never executes.** The copilot can only create *drafts* (an order ticket prefill or a strategy version). A human confirms every order and every go-live.
- **Kill switch everywhere.** It has three scopes: robots / robots + cancel orders / robots + cancel + flatten. It sits in the top bar, is bound to the hotkey Ctrl+Shift+K and requires a 1.5 s hold. It works even if the UI loses its websocket, through a REST fallback.
- **Immutable audit log.** Every signal, order, parameter change, override, AI suggestion and kill-switch action is recorded append-only and hash-chained.
- **Accessibility and colour-blind safety.** Buy/up = blue `#4DA3FF`, sell/down = orange `#FF9F40` in Pro. Colour is never the only cue (▲▼ and +/− are always shown). WCAG 2.2 AA throughout.
- **No gamification.** No confetti, streaks, leaderboards or push nudges to trade.
- **Traceability.** Every number shown in the UI must trace to a source: a feed, the engine or a calculation with a unit test. Placeholders stay explicit (`[XX]%` for the regulatory retail-loss figure) until Legal supplies the value.

## Reference architecture (monorepo, pnpm + Turborepo)
```
kora/
  apps/web/            Next.js (App Router) + TypeScript + Tailwind (CSS-variable tokens), TanStack Query, Zustand, lightweight-charts
  apps/api/            NestJS + TypeScript: REST (OpenAPI) + WebSocket gateway, zod DTOs
  services/quant/      Python 3.12 + FastAPI: Monte Carlo, backtests, metrics (numpy, pandas, numba)
  services/bot-runner/ TypeScript worker (BullMQ): live/paper strategy execution
  packages/ui/         Design system: tokens (pro-dark, novice-light), primitives, charts
  packages/domain/     Shared types: Instrument, Order, Fill, Position, Strategy, AuditEvent
  packages/sdk/        Typed API + WS client generated from OpenAPI
  infra/               docker-compose (Postgres+TimescaleDB, Redis, Keycloak, OTel collector, Prometheus, Grafana)
  docs/                ADRs, goal prompts, runbooks, control matrix
```
Auth: OIDC via Keycloak, TOTP MFA and role-based access control (RBAC) with the roles `novice`, `trader`, `quant`, `risk_officer` and `admin`.
AI: the Anthropic Claude API through the official SDK. The model ID is read from the env variable `KORA_AI_MODEL`, never hard-coded.

If a module prompt needs a different choice, write an ADR in `docs/adr/` first and explain why.

## Engineering standards
- TypeScript `strict`, and ESLint + Prettier. Python uses ruff, mypy `--strict` and pytest.
- Money and prices use **decimal** types (never float) in the domain and database. Precision is set per instrument from the registry.
- Every module ships:
  - unit tests (≥ 85% on domain logic), integration tests and Playwright e2e for its key flows;
  - OpenAPI docs, a README section and at least one ADR;
  - structured logs and OpenTelemetry traces.
- Seed data is clearly labelled SIMULATED. There are no real customer or market data in fixtures.
- Security:
  - OWASP ASVS L2 mindset: secrets only from env or vault, rate limits on order and AI endpoints, CSP headers.
  - Content fed to the LLM (news, user text) is treated as untrusted data.

## Sequencing (one /goal per session, commit after each)
| # | Prompt | Depends on |
|---|---|---|
| 01 | Foundation: monorepo, auth, design system, app shell, audit log | — |
| 02 | Market data service | 01 |
| 03 | Order management + paper trading engine + risk + kill switch | 01, 02 |
| 04 | Pro Terminal UI | 02, 03 |
| 05 | Gain Simulator (quant service + UI) | 01 (03 for paper history) |
| 06 | Robot Trader: DSL, backtester, bot runner | 02, 03, 05 |
| 07 | AI Copilot | 03, 04, 06 |
| 08 | Novice view (desktop + mobile PWA) | 03, 04, 05 |
| 09 | Risk, compliance and governance layer | all |
| 10 | QA, security hardening, observability, release | all |

## Working rules for Claude on every module goal
1. Read `CLAUDE.md`, this file, the module prompt and the relevant prototype artboard before writing code.
2. Write a short plan to `docs/plans/<module>.md` covering files, schema changes, risks and test plan, then execute it.
3. Work in small commits (Conventional Commits). Never push or deploy unless asked.
4. Don't invent market figures, regulatory numbers or broker capabilities. Use placeholders and list them in `docs/open-questions.md`.
5. A module is done only when **every acceptance criterion in its prompt passes**: run the tests, run the e2e flows and paste the results in the plan file.
6. At the end, update `docs/STATUS.md` with what shipped, what is stubbed and what the next goal needs.

## Global definition of done
`pnpm i && docker compose up -d && pnpm dev` brings up web, api, quant and bot-runner locally with seeded simulated data. A new user can then:
1. sign up with MFA;
2. switch Pro ⇄ Novice;
3. place, amend and cancel paper orders;
4. run a Monte Carlo projection;
5. build, backtest and paper-run a robot;
6. ask the copilot why a signal fired;
7. hit the kill switch;
8. see every one of those actions in the audit log.

All CI checks must be green.
