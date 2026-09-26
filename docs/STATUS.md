# KORA — delivery status

Last updated: 2026-09-26 (end of goal 01).

| Gate | Goal | State |
|---|---|---|
| G0 | 00 master plan | **Done**: `docs/plans/00-master.md`, ADR 0000/0001, charter |
| G1 | 01 foundation | **Done, with deferrals**: see `docs/plans/01-foundation.md` §4 and §6 |
| G2 | 02 market data | Next |

## What shipped in goal 01

- **Monorepo:**
  - pnpm + Turborepo;
  - shared TS/ESLint/Prettier configs (`packages/config`);
  - ruff and mypy configs in `services/quant/pyproject.toml`.
- **Native dev services:** `scripts/dev-db.sh` (Postgres :55432, Redis :56379, `.data/`). `pnpm dev` works without Docker.
- **API (`apps/api`):**
  - dev OIDC IdP (sign-up, scrypt, TOTP enrolment and verification, ES256 JWT + JWKS);
  - global auth guard (CSRF, MFA rule, `@Roles`);
  - `user_preferences`;
  - `POST /kill-switch` (audited intent);
  - `GET /audit`, `GET /audit/verify`;
  - `/health` (db, redis, keycloak);
  - OpenAPI at `/docs`.
- **Audit:** append-only, hash-chained `audit_events`. Insert-only runtime role, owner-level immutability trigger, tamper detection with the first broken id.
- **Design system (`packages/ui`):**
  - pro-dark and novice-light tokens;
  - 16 primitives, including `HoldToConfirmButton`, decimal-safe `NumberInput`, `DirectionBadge`, and `Money`/`Price`;
  - Storybook with the a11y addon;
  - axe on every story (jsdom and Chromium);
  - contrast check (106 pairs).
- **Web (`apps/web`):**
  - login, sign-up and QR TOTP enrolment;
  - middleware session and role guards (friendly 403) with a CSP nonce;
  - Pro shell (top bar, left rail, status bar) and Novice shell (tabs, risk banner, mobile bottom bar);
  - Pro ⇄ Novice toggle, persisted and instrument-preserving, with a "what changed" note;
  - kill switch (1.5 s hold by mouse, touch, Space or Ctrl+Shift+K → three scopes → audit event);
  - audit viewer with chain verification; settings.
- **Services:** quant (FastAPI `/health`) and bot-runner (BullMQ heartbeat worker, `/health`).
- **Infra:** compose reference (Timescale, Redis, Keycloak, OTel, Prometheus, Grafana), Keycloak realm with conditional OTP, Dockerfiles, and the GitHub Actions CI.

## Stubbed or placeholder (explicit in the UI)

- Account summary values, watchlist, chart, order preview numbers and blotter are shown as "—" or as "arrives in goal NN".
- The kill switch records intent only (`engine: not_wired_goal_03`).
- The robot builder, simulator, practice, auto-invest and learn pages are placeholders.
- The command palette is an entry point only.

## Deferred (reasons in plan 01 §6)

- The Keycloak and compose runtime path (B-001).
- The Trivy and image builds (B-008).
- A GitHub Actions run (cannot push from this session).

## What goal 02/03 needs to know

- **Start the DB:** `bash scripts/dev-db.sh start`, or just `pnpm dev`. Migrate with `pnpm db:migrate`; use `pnpm db:migrate --all` to also migrate `kora_test`.
- **Add migrations:** as `apps/api/migrations/NNNN_name.sql`. They are forward-only and checksummed. Each one must `GRANT` explicitly to `kora_app` (and `kora_audit_reader` for read-only). Timescale: `create_hypertable` only inside `IF EXISTS (select from pg_extension where extname='timescaledb')`.
- **Audit:** inject `AuditService` and call `record({actorId, actorType, action, entity, entityId, payload}, client?)`.
  - Pass the transaction `client` so the audit row commits atomically with the business change. The transaction must be READ COMMITTED.
  - Payload numbers must be safe integers. Send decimals as strings.
  - Action names look like `kill_switch.requested`, matching the regex `^[a-z0-9_]+(\.[a-z0-9_]+)*$`.
- **Auth in the API:** every route is authenticated by default. Use `@Public()` to opt out and `@Roles(...)` to restrict. Non-novice roles always need `amr: otp`. `@CurrentPrincipal()` gives `{sub, roles, mfa}`.
- **Auth in tests:** use the real flow (`apps/api/test/helpers.ts`):
  - `createUser(app, 'novice' | 'trader', extraRoles?)` signs up, logs in and does TOTP enrolment/verify, then returns a bearer token.
  - `nextTotpWindow()` advances the faked `Date` 31 s, so repeated logins don't hit TOTP replay protection.
  - Extra roles are granted with a direct owner SQL insert.
  - Send `x-kora-csrf: 1` on unsafe requests unless you use `Authorization: Bearer`.
  - e2e uses `apiSignIn(page, type)` in `apps/web/e2e/helpers.ts`.
- **Decimals:** `import { dec, quantize, roundToTick, Decimal } from '@kora/domain'`. `dec(0.1)` throws by design. The UI formats via `formatPrice(value, precision)` and `formatMoney` from `@kora/ui`.
- **Kill switch:** the web calls `POST /kill-switch {scope, source}` with scopes `robots | robots_cancel | robots_cancel_flatten`. Goal 03 replaces the intent-only handler with the engine and audits each child action.
- **Order types:** the server capability is `GET /me → capabilities.orderTypes` (novice view = `['market']`). The goal 03 OMS must enforce role guardrails server-side (goal 08).
- **Ports:**
  - dev: web 3000, api 4000, quant 8000, bot-runner 4100;
  - e2e: api 4010, web 3010, db `kora_e2e`;
  - integration tests: db `kora_test`.
- **Env:** everything lives in the repo-root `.env`. The api and web load it themselves and never override variables that are already set.

## Goal 05: gain simulator (G5: done, with deferrals)

Plan and evidence: `docs/plans/05-gain-simulator.md`. ADR 0005. Built in parallel with goal 02, on its own branch. Gate table row to add when merging: `| G5 | 05 gain simulator | **Done, with deferrals**: see plan 05 §5–§6 |`.

### What shipped

- **Quant (`services/quant/src/kora_quant/sim/`):**
  - `POST /mc/project` (parametric edge) and `POST /mc/from-trades` (circular moving-block bootstrap, block auto `⌈n^{1/3}⌉` or user-set);
  - `POST /analytics/paper` (Decimal FIFO analytics over `Fill[]`) and `POST /reality-checks`;
  - numpy PCG64 plus a numba kernel, seeded and deterministic, LRU-cached by input hash;
  - defaults: 10k paths, max 50k;
  - 10k × 1,000 trades in **163 ms p95** (`bench/RESULTS.md`);
  - 85 pytest tests, 98.9% coverage, passing on Python 3.11 and 3.12.
- **Model:** R-multiple outcomes with costs on by default, fat tails, a stress edge cut, three sizing models (fixed-fractional, fixed amount, Kelly fraction), withdrawals and a ruin floor.
- **Outputs:**
  - P5–P95 bands, final distribution, P(below start), risk of ruin plus a closed-form estimate;
  - drawdown median/P95/histogram, time under water, longest losing streak;
  - expectancy after costs, full Kelly after costs and tails, and the user/Kelly ratio;
  - 3 sample paths and reality checks.
- **Reality checks:** 6 pure rules with rationales in `docs/quant/reality-checks.md`. The model is described in `docs/quant/monte-carlo.md`.
- **API (`apps/api/src/sim/`):**
  - `POST /sim/project`, `POST /sim/from-trades`, `GET /sim/paper/analytics`, `POST /sim/paper/project`;
  - zod validation with plain-language rejections;
  - `KORA_SIM_RATE_LIMIT` per client per minute (default 60);
  - audit events `sim.projection_run`, `sim.bootstrap_run` and `sim.paper_projection_run`;
  - quant failures map to 502/503 with "Nothing was simulated".
- **Web Pro (`/simulator`):**
  - assumptions panel;
  - SVG fan chart (bands, median, start, ruin floor, 3 sample paths) with the SIMULATED watermark;
  - 5 KPI tiles, drawdown histogram, risk table, reality checks;
  - stress and fat-tail toggles;
  - "Project from my paper results";
  - "Import from backtest" placeholder (goal 06);
  - A/B compare (overlay and table);
  - CSV and PNG export.
- **Web Novice (`/practice`):**
  - three plain questions: how much, how often, how careful;
  - good / typical / bad year, a band chart, "This is a simulation, not a promise";
  - glossary links, with an automated jargon scan in e2e.
- **Tests:**
  - api integration: 18 new (43 total);
  - web unit: 8 new;
  - e2e: 5 new (21 total, all green).

### Stubbed or placeholder

- Paper fills come from a deterministic **SIMULATED fixture** (`apps/api/src/sim/paper-fixture.ts`, 80 round trips). It is labelled in the API response and the UI until the goal 03 engine exists (B-018).
- "Import from backtest" is an `aria-disabled` button that names goal 06 (B-019).

### What goals 03, 06 and 08 need to know

- **Goal 03:** replace `paperFixtureFills()` in `SimController.paperAnalytics()` with the account's fills (same `Fill` shape, decimal strings, tz-aware `ts`). Pass `contractMultipliers` from the instrument registry for non-quote-currency P&L. Drop `?simulated_source=true` once the fills are real.
- **Goal 06:** "Send to Monte Carlo" posts `{trades: number[] (R multiples), source: 'backtest_in_sample' | 'backtest_out_of_sample', riskPct, blockSize?}` to `/sim/from-trades`. The `small_sample` and `in_sample_source` checks fire on their own.
- **Goal 08:** the Practice mapping lives in `apps/web/src/lib/sim/practice.ts`, and the glossary and jargon list in `apps/web/src/lib/sim/glossary.ts`. Human copy review is B-021, and the product stance on the skill-free edge is OQ-Q1.
- **Env:** `QUANT_URL` (default `http://127.0.0.1:$QUANT_PORT`), `QUANT_TIMEOUT_MS`, `KORA_SIM_RATE_LIMIT`. Playwright starts uvicorn on `E2E_QUANT_PORT` (default 8010), and the api gets `QUANT_URL` automatically.
- **Numbers:** simulation outputs are float estimates, always labelled SIMULATED and never booked. Paper P&L is Decimal (ADR 0005 §4).
