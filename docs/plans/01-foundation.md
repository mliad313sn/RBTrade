# Plan 01 — Foundation (monorepo, identity, design system, app shell, audit log)

Lead seats: S3 (architect), S1 (designer), S9 (security). Gate lenses: S8, S10.
Status: **G1 passed, with deferrals** (see §6). Verified 2026-09-26 in the cloud build environment: no Docker, native Postgres 16 and Redis 7, Node 22, Python 3.11.

## 1. What was built

| Area | Path | Notes |
|---|---|---|
| Monorepo | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `packages/config` | pnpm 10 + Turborepo 2. Shared tsconfig presets and ESLint flat config. The ESLint config bans `parseFloat`, `Number.parseFloat` and `Math.random`. |
| Env | `.env.example` | Every variable documented. `scripts/dev-db.sh` creates `.env` and generates dev-only keys into it. |
| Native DB | `scripts/dev-db.sh`, `scripts/db-bootstrap.sh`, `scripts/gen-dev-secrets.mjs` | Postgres on :55432 and Redis on :56379 under `.data/`. Creates roles `kora_owner`, `kora_app` and `kora_audit_reader`, and databases `kora`, `kora_test` and `kora_e2e`. |
| Domain | `packages/domain` | `Decimal` (decimal.js clone, half-even) and `dec()`, which rejects JS floats. Also roles plus MFA rules, preferences schema, kill-switch contract, audit canonical JSON and hash chain (`@kora/domain/server`), and shared types. |
| API | `apps/api` | NestJS 11 with zod DTOs and OpenAPI at `/docs` (non-prod). Includes:<br>• dev OIDC IdP with TOTP<br>• global `AuthGuard` (CSRF, JWT via JWKS, global MFA rule, `@Roles`)<br>• preferences<br>• kill-switch intent<br>• audit service and controller<br>• `/health` (db, redis, keycloak)<br>• pino logs with redaction, optional OTel<br>• helmet, throttling, account lockout |
| Migrations | `apps/api/migrations/0001_foundation.sql`, `apps/api/src/db/migrate.ts` | Plain SQL with a checksum runner (ADR 0001). |
| Design system | `packages/ui` | `tokens.ts` → generated CSS. 16 primitives plus `EnvChip`, with Storybook 9 and the a11y addon. |
| SDK | `packages/sdk` | Typed fetch client stub plus `openapi.json` exported from the api. |
| Web | `apps/web` | Next.js 15.5 App Router, TS strict, Tailwind v4 mapped to `--k-*` tokens. Includes:<br>• middleware (JWKS session check, per-request CSP nonce, role guards with a real 403 page)<br>• same-origin `/api/*` proxy<br>• auth flow with QR enrolment<br>• Pro and Novice shells, kill switch, audit viewer, settings |
| Quant | `services/quant` | FastAPI `/health` and decimal helpers. ruff, mypy `--strict` and pytest with coverage ≥ 85%. |
| Bot runner | `services/bot-runner` | BullMQ worker (heartbeat job only; any other job is rejected) with `/health`. |
| Infra | `docker-compose.yml` → `infra/docker-compose.yml`, `infra/keycloak/realm-kora.json`, `infra/otel`, `infra/prometheus`, `infra/grafana` | Deployment reference only (ADR 0000). |
| CI | `.github/workflows/ci.yml` | Jobs:<br>• node: build, lint, typecheck, unit, contrast, integration, Storybook plus Chromium axe, e2e<br>• python 3.11/3.12<br>• pnpm audit + Trivy fs<br>• image build + Trivy image |
| Images | `apps/api/Dockerfile`, `apps/web/Dockerfile`, `services/*/Dockerfile` | Built only in CI. |

### Schema (migration 0001)

- `users`: uuid, email (unique `lower()`), scrypt `password_hash`, provider, lockout fields.
- `user_roles (user_id, role)`: role is `CHECK`ed against the five roles.
- `user_mfa`: TOTP secret sealed with AES-256-GCM, bound to the user id as AAD. Also `enabled_at` and `last_used_step`, used for replay protection.
- `user_preferences`: `view_mode` (pro|novice), `theme`, `colour_convention` (`blue_orange` default | `green_red` | `red_up_asia`), `hotkeys` (jsonb).
- `audit_events`: id, ts (µs UTC), actor_id, actor_type, action, entity, entity_id, payload, prev_hash, hash.
  - A `BEFORE UPDATE/DELETE/TRUNCATE` trigger blocks changes for everyone.
  - `kora_app` has `SELECT, INSERT` only; `UPDATE`, `DELETE` and `TRUNCATE` are revoked.

### Key design decisions (with ADRs)

- **ADR 0000:** native Postgres/Redis for dev and test; compose is the reference.
- **ADR 0001:** confirms the stack.
  - Pinned majors.
  - Plain SQL migrations.
  - Deviations: dev IdP, optional Timescale, Python 3.11, Next 15.5, hand-written SDK, cookie over a same-origin proxy.
- **ADR 0101:** the identity contract.
  - Keycloak-shaped claims `realm_access.roles` and `amr`.
  - The global MFA rule.
  - The two-step login with a 5-minute `mfaToken`.
  - Self-service account types limited to `novice` and `trader`.
- **ADR 0102:** the audit chain.
  - Advisory-lock serialisation.
  - id = last + 1, so rollbacks leave no gaps.
  - Canonical JSON rejects floats.
  - Owner-level trigger plus role-level revoke.

## 2. How to run

```bash
pnpm i
pnpm dev            # starts native Postgres+Redis, migrates, then web :3000, api :4000, quant :8000, bot-runner :4100
# with Docker instead: docker compose up -d && pnpm dev:apps   (set ports in .env to 5432/6379)
pnpm db:seed        # optional: SIMULATED demo users per role (needs KORA_SEED_PASSWORD)
```

## 3. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tokens verified differently in web and api | Both use the JWKS and the same claim rules (`requiresMfa` from `@kora/domain`). The API is authoritative. |
| Hash-chain race or false id gaps | Advisory lock; a 50-writer concurrency test; a rollback test. |
| Floats in money or audit | `dec()` and `canonicalJson` reject floats, backed by the ESLint rule and a `NumberInput` without `parseFloat`. |
| A rewrite cannot set a 403 status in Next middleware | Middleware fetches `/forbidden` and returns it with status 403 (e2e verified). |
| CSP breaks hydration | Nonce + `strict-dynamic`. All pages are rendered dynamically. |
| Spoofed `X-Forwarded-For` through the proxy | The proxy forwards only the nearest hop. The deployment edge proxy is B-015. |

## 4. Acceptance criteria (Project Owner tick sheet)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `docker compose up -d && pnpm dev` starts everything. `/health` returns the status of db, redis and keycloak. | **Pass (native path); compose deferred** | `pnpm dev` brought up api `:4000/health` 200, web `:3000/login` 200, quant `:8000/health` 200, bot-runner `:4100/health` 200, and web proxy `/api/health` 200. `/health` returns `checks.db`, `checks.redis` and `checks.keycloak` (`skipped` with the dev IdP; probed when `AUTH_PROVIDER=keycloak`). Integration test `health.int.test.ts` and e2e `auth.spec.ts:5`. `docker compose up` cannot run here (no daemon). YAML was validated with a parser; the compose run is in CI/Docker (B-001). |
| 2 | Sign-up → MFA enrolment → login works. A `novice` cannot reach `/robots/*` (403 plus a friendly page). | **Pass** (dev IdP); Keycloak deferred | e2e `auth.spec.ts:18`: UI sign-up as trader → QR/secret → TOTP → terminal → sign out → login → wrong code rejected → right code. API tests cover enrolment, replay rejection, the MFA token not being a session, the global MFA rule, role grants forcing enrolment, and lockout. e2e `rbac.spec.ts:5`: `/robots` and `/robots/builder` return HTTP 403 with the friendly page, and API `/robots/builder` returns 403. |
| 3 | Pro/Novice toggle persists per user and survives reload. Novice hides advanced order types (e2e). | **Pass** | e2e `mode.spec.ts`: toggle → `/home?symbol=XAUUSD&switched=novice` with the "what changed" note and the same instrument (Gold preselected). No Stop-limit, Trailing, Bracket or OCO. Survives reload; `/api/me` shows `viewMode: novice`, `orderTypes: ['market']`. Back to Pro restores the advanced types. The API test checks per-user isolation and the audit event. |
| 4 | Kill switch needs a 1.5 s hold (mouse, touch, keyboard Space-hold) and opens the three-scope menu. Choosing a scope writes an audit event. | **Pass** | e2e `kill-switch.spec.ts`: a 0.7 s press doesn't open the menu; a 1.65 s mouse hold does; also Space-hold, touch pointer hold, and the Ctrl+Shift+K hold (`source: hotkey`). Each scope choice appears in `GET /api/audit?action=kill_switch.*`. Unit tests (fake timers): 1499 ms doesn't confirm, 1500 ms does; release, leave, Escape and right-click cancel; key repeat doesn't restart. |
| 5 | `GET /audit/verify` returns `valid:true`. A manual tamper of one row makes it return `valid:false` with the first broken id. | **Pass** | `audit.int.test.ts`. The owner disables the trigger, updates one payload and re-enables it → `{valid:false, firstBrokenId:<id>, reason:'hash_mismatch'}`. Restoring the row makes it valid again. Also covered: `kora_app` UPDATE/DELETE/TRUNCATE fail with 42501; grants are exactly INSERT and SELECT; the owner is blocked by the trigger. e2e: the audit page shows "Chain valid.". |
| 6 | Every primitive has a Storybook story with no axe violations. Text contrast ≥ 4.5:1 in both themes (automated). | **Pass** | 16/16 primitives have stories.<br>• vitest + axe-core: 84 story renders (42 stories × 2 themes), 0 violations.<br>• **Chromium** axe on the built Storybook: 84/84, contrast included.<br>• `pnpm contrast`: 106/106 pairs ≥ 4.5:1 (both themes, all three colour conventions).<br>• Playwright axe on `/login`, `/signup`, `/terminal`, `/settings`, `/home` (desktop + mobile) and `/forbidden`: 0 serious violations, 0 contrast violations. |
| 7 | CI is green. `docs/adr/0001-stack.md` and `docs/STATUS.md` are written. | **Partially deferred** | Every CI step that can run here passes locally (log below). The workflow itself cannot run from this session (no push, no Actions). Trivy and image builds need Docker (B-008). The ADRs and STATUS are written. |

## 5. Verification log (pasted)

```
$ pnpm build            →  Tasks: 6 successful, 6 total
$ pnpm lint             →  Tasks: 10 successful, 10 total
$ pnpm typecheck        →  Tasks: 10 successful, 10 total
$ pnpm test --force     →  Tasks: 10 successful, 10 total
  @kora/domain      Tests 22 passed   coverage lines 100% / branches 98.95%
  @kora/api (unit)  Tests 26 passed   coverage lines 99.19% (totp, password, crypto-box, zod, config)
  @kora/ui          Tests 113 passed  coverage lines 99.32% / branches 91.55%   (incl. 84 axe renders)
  @kora/sdk         Tests 4 passed    coverage lines 98.8%
  @kora/bot-runner  Tests 5 passed    coverage lines 97.1%  (real Redis: BullMQ job + /health)
  @kora/web         Tests 5 passed    (route rules, mode mapping)
  @kora/quant       11 passed         coverage 90.91% (>= 85% gate)
$ pnpm contrast         →  106/106 pairs meet 4.5:1
$ pnpm --filter @kora/api test:integration   (real Postgres 16 + Redis 7)
  ✓ test/auth.int.test.ts (9 tests)
  ✓ test/audit.int.test.ts (7 tests)
  ✓ test/preferences-killswitch.int.test.ts (6 tests)
  ✓ test/lockout.int.test.ts (1 test)
  ✓ test/health.int.test.ts (2 tests)
  Tests 25 passed (25)
$ pnpm --filter @kora/ui build-storybook && pnpm --filter @kora/ui test:storybook-axe
  84/84 story renders have no axe violations (contrast included) in Chromium
$ pnpm test:e2e   (Playwright 1.56.1, Chromium 1194, api :4010 + next start :3010, db kora_e2e)
  ✓  1 a11y › login and sign-up pages have no serious axe violations (incl. colour contrast)
  ✓  2 a11y › pro shell and novice shell pass axe in Chromium
  ✓  3 a11y › forbidden page passes axe
  ✓  4 a11y › novice mobile layout shows the bottom tab bar (no horizontal scroll)
  ✓  5 auth › health reports db, redis and keycloak through the web proxy
  ✓  6 auth › anonymous users are sent to /login
  ✓  7 auth › sign-up as trader → MFA enrolment → pro terminal → sign out → login with TOTP
  ✓  8 auth › sign-up as novice lands in the simple view without MFA
  ✓  9 kill-switch › short press does not open; 1.5 s mouse hold does; scope writes an audit event
  ✓ 10 kill-switch › keyboard Space-hold opens the menu
  ✓ 11 kill-switch › touch hold opens the menu
  ✓ 12 kill-switch › Ctrl+Shift+K held for 1.5 s opens the menu (source: hotkey)
  ✓ 13 kill-switch › the audit page verifies the chain
  ✓ 14 mode › toggle persists, survives reload, Novice hides advanced order types
  ✓ 15 rbac › novice cannot reach /robots/* builder routes: 403 + friendly page
  ✓ 16 rbac › trader can open the robot builder
  16 passed (31.0s)
$ bash scripts/py-check.sh   (Python 3.11.15)
  ruff check: All checks passed! · ruff format: 8 files already formatted
  mypy --strict: Success: no issues found in 7 source files
  pytest: 11 passed · coverage 90.91%
$ pnpm audit --prod      →  No known vulnerabilities found
$ pnpm dev               →  api /health 200 · web /login 200 · quant /health 200 · bot-runner /health 200
```

## 6. Deferred with reason

| Item | Reason | Backlog |
|---|---|---|
| `docker compose up -d` path, Keycloak realm import, conditional OTP by role, BFF `/auth/oidc/*` against a real Keycloak | No Docker daemon or Keycloak here. The realm JSON and compose YAML were syntax-validated only. | B-001 |
| Trivy image and filesystem scans; Docker image builds | No Docker, and GitHub release downloads are blocked by the proxy. `pnpm audit` and pip `ruff`/`mypy` ran instead; `pip-audit` runs in CI. | B-008 |
| "CI is green" on GitHub Actions | This session cannot push or trigger Actions. Every CI step except Docker/Trivy was run locally and passes. | — |
| Grafana dashboards and alert → runbook links | Provisioning stub only (datasource). Out of goal 01 scope. | B-012 |
| Command palette actions (⌘K) | Shell entry point only. Actions come with goal 04. | B-009 |
| Account summary numbers (equity, P&L, margin, loss limit) | Need the paper engine (goal 03). Shown as "—", never invented. | — |

## 7. Gate review notes (S8 / S9 / S10)

- **S9:**
  - scrypt passwords;
  - TOTP secrets encrypted at rest; replay-protected; ±1 step window;
  - lockout after 10 failures (password or TOTP);
  - auth rate limit;
  - CSRF header on every unsafe request;
  - HttpOnly + SameSite=Strict cookie;
  - helmet on the api; CSP nonce on web;
  - log redaction of authorization, cookie, password, code, secret and tokens;
  - the dev IdP refuses production; LIVE refused at boot by api, quant and bot-runner.

  Findings logged: B-014 (sign-up email enumeration), B-015 (edge proxy for client IP), B-002 (revocation).
- **S8:**
  - `[XX]%` placeholder kept (OQ-R1);
  - PAPER chip always visible;
  - no invented account numbers;
  - `trader` self-service at sign-up raised as OQ-S2.
- **S10:** the test pyramid is in place (unit → integration on real Postgres → e2e). Visual regression against the prototype is scheduled for goal 04 (B-011).
- **S1:**
  - shell layout matches `Main.png` (hazard stripe, search ⌘K, PAPER chip, account slot, Pro/Novice, KILL SWITCH, rail, status bar) and `Novice.png` (tabs, Practice money chip, Simple/Pro, risk banner, cards);
  - buy/sell fills use ink text for AA (OQ-D2);
  - the novice `raised` surface is lighter than paper, so the mandated up/down colours keep ≥ 4.5:1.
