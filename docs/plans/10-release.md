# Plan 10 — QA, security hardening, observability and release readiness

Lead seats: S10 (QA / SRE, lead), S9 (security engineer), S3 (software architect); S1 for the
accessibility and UX audit. Gate lenses: S8 (risk), Project Owner.
Inputs: master goal (incl. the 2026-09-26 scope amendment), goal 10, charter, every ADR, plans 00–09,
STATUS hand-overs (goal 02 load harness, goal 03 targets, goal 06 runner, goal 07/07B AI threat model,
goal 08 Lighthouse, goal 09 security review targets, SLOs and release items), BACKLOG items targeted to
10, `docs/open-questions.md`.

**Rule of this goal: fix what we find, don't add features.** Backlog items targeted to 10 that are new
product features are re-targeted post-RC with a reason (§5); items that are quality, security or
operability work named by goal 10 are done here.

## 1. Environment limits and how each is handled

| Limit | Consequence | Handling |
|---|---|---|
| No Docker daemon | No compose e2e, no image build, no Trivy image scan, no Keycloak | e2e and chaos run against the **native** stack (Postgres :55432, Redis, api, quant, bot-runner, web) — same code and migrations as compose. Image build + Trivy stay CI jobs (B-008). Keycloak path stays B-001 (Sponsor launch item). |
| GitHub downloads blocked | No k6 binary, no gitleaks/trufflehog binaries, no ZAP | Load: `autocannon` (npm) + the committed Node WS generator. Secrets: `detect-secrets` (PyPI) over **every blob in git history** plus a documented regex pass. ZAP baseline: **deferred to staging**, owner S9, job written in the staging pipeline. |
| No GitHub Actions run | CI yaml cannot be proven green remotely | Every CI stage is run locally with the same commands; the real run is a Sponsor launch item. |
| No AI key | Live provider evals impossible | Scripted provider evals (CI gate); AI-provider chaos uses an unreachable provider endpoint. |

## 2. Work items

### 2.1 Test pyramid audit (S10)
- Measure coverage per package (TS unit, api unit + integration, quant, web lib) → `docs/qa/coverage.md`.
- Domain logic ≥ 85 %: `packages/domain`, `packages/market-data`, api pure cores, quant already gated;
  add coverage gating to `apps/web` pure `src/lib/**` logic and raise any module under 85 %.
- **Contracts (B-004/B-209/B-312):** zod response schemas for the contract surface (auth/me, market
  data, orders/preview/positions/fills/account, kill switch, audit, appropriateness, sim, robots,
  strategies, governance) attached to OpenAPI from the same zod schemas; `openapi.json` regenerated;
  `openapi-typescript` generates `packages/sdk/src/generated/openapi.ts`; a type-level test proves the
  SDK's types match the generated ones. Contract tests:
  - web/SDK ↔ api: an integration test calls every documented endpoint with a response schema and
    validates the live response against the OpenAPI document (ajv);
  - api ↔ quant: the api's quant request payloads validated against quant's own FastAPI OpenAPI, and
    quant responses parsed by the api's zod parsers;
  - bot-runner ↔ api: the runner's internal calls validated against the api OpenAPI (`/internal/*`).

### 2.2 Golden-path e2e (S10)
Map the 7 flows to specs; fill gaps: risk-officer four-eyes approval, audit chain verification,
copilot explain + draft → ticket, robot build → backtest → paper → kill switch halts the robot
(`golden-path.spec.ts` where a flow is missing). Suite run 3× at the end; flaky tests fixed.

### 2.3 Chaos (S10)
`scripts/chaos/run.mjs`: starts an isolated native stack (own Redis on a scratch port, own DB
`kora_chaos`, api, separate market-data feed process `md:feed`, quant, bot-runner, a fake AI provider
endpoint), then one at a time: kill the feed → stale badge + `MARKET_DATA_STALE` rejections, no fills;
kill Redis → health degraded, REST kill switch still works, no orders; kill quant → sim/backtest 503
"Nothing was simulated", runner skips, no orders; kill AI provider → "Copilot unavailable", trading
unaffected. After each: restart, recovery, **no duplicate orders** (clientOrderId replay + order counts).
Evidence: JSON log + Playwright screenshots in `docs/qa/chaos/`, summary `docs/qa/chaos.md`.

### 2.4 Load (S10, S3)
`apps/api/load/`: 500 terminal users (WS + REST mix), 200 symbols streaming (goal 02 harness), 50 bots
on 1m bars (runner + synthetic bar closes), 100 orders/s burst (autocannon). p50/p95/p99 + error rates
vs goal 02 (WS p99 < 50 ms, candles p95 < 150 ms), goal 03 (risk < 5 ms, kill switch < 2 s) and SLO-2
(order ack p99 < 250 ms) → `docs/qa/load.md`. Misses → fix or Sponsor exception with an owner.

### 2.5 Security (S9)
- `docs/security/threat-model.md`: STRIDE for auth/session, orders/OMS, AI/intel, admin, governance,
  WS, service-to-service; each threat → mitigation → test/evidence → residual risk.
- SAST: Semgrep (registry rulesets for TS/JS/Python/secrets + a repo `.semgrep.yml` for KORA
  invariants) — zero high/critical after fixes; config + CI job committed.
- Dependencies: `pnpm audit` (all, prod gate high+) and `pip-audit` — zero high/critical.
- Secrets: `scripts/security/secrets-history.py` (detect-secrets on every unique blob in history +
  regex) with a reviewed allowlist of dev-only values.
- DAST: ZAP baseline job in the staging pipeline; **deferred to staging**, owner S9.
- **Authz matrix:** integration test enumerates every Nest route (path, method, `@Public`, `@Roles`)
  from the running app, checks it is in OpenAPI, and calls it as anonymous and as each of `novice`,
  `trader`, `quant`, `risk_officer`, `auditor`, `admin`: anonymous → 401 unless public; role not in
  `@Roles` → 403; allowed → never 401/403. Matrix written to `docs/security/authz-matrix.md`.
- Rate limits (auth, orders, AI, sim, research), CSRF (header rule, SameSite=strict), CSP and security
  headers (api helmet and web middleware nonce CSP) as tests.
- Session and MFA hardening: logout revokes the token server side (jti denylist in Redis until
  expiry), role changes and MFA resets invalidate older tokens; **B-902 recovery codes** (10 one-time
  codes, hashed, shown once, usable instead of TOTP, audited, regenerate needs TOTP). B-015 trusted
  proxy configuration.
- Goal 09 review targets: four-eyes triggers, auditor SoD, evidence export (CSV injection, PDF),
  subject-access export (no secrets), `risk:alerts` authorisation, WS quotas, TLS enforcement,
  anchor key handling, B-014 — each checked with a test reference in the threat model.

### 2.6 Observability (S10)
- Custom spans on the order path (`oms.submit`, `risk.evaluate`, `audit.record`, `engine.match`,
  `engine.fill`), trace context stored on the order so the asynchronous fill joins the ticket's trace;
  bot-runner and quant propagate W3C `traceparent` (B-507/B-603). File/in-memory exporter for tests;
  an integration test proves one trace from `POST /orders` to the fill (and runner → api → quant).
- Prometheus metrics for orders (ack latency histogram, rejections by code, fills, slippage), feed
  health, bot heartbeats, kill switch, alert relay, four-eyes, anchors, backups; existing AI metrics.
- Grafana dashboards JSON (feed health, order latency, rejection reasons, fills/slippage, bot
  heartbeats, AI tokens/cost, error budgets/SLOs) — B-012, B-916, B-758.
- Prometheus alert rules, each with a `runbook_url` to a goal 09 runbook; a test fails when an alert
  has no runbook or the file does not exist.

### 2.7 Accessibility and UX (S1)
axe (WCAG 2.2 AA tags) on **every route** for its role(s), both themes; keyboard-only walkthrough
spec (skip link, focus order, kill switch by keyboard, dialogs trap/return focus); colour-convention
setting verified (blue/orange default + inverse, ▲▼ always present); screen-reader spot checks
(landmarks, live regions, names) recorded; mobile Lighthouse re-run on novice routes after goal 08's
last CSS change → `docs/qa/a11y.md`.

### 2.8 Release (S10, S3)
- Version `1.0.0-rc.1` across workspace packages and the OpenAPI doc; `CHANGELOG.md` from git
  history (conventional-changelog).
- `.github/workflows/release.yml`: build → scans → images → staging deploy behind a GitHub
  environment with required reviewers (manual approval), sets `KORA_BUILD_SHA` and
  `KORA_RELEASE_APPROVAL_REF`, ZAP baseline against staging.
- Migration rollback: migrations are forward-only and checksummed (ADR 0001), so rollback is
  **restore-based**: `scripts/migrate-rollback-test.sh` dumps, applies a probe migration, restores the
  pre-migration dump, verifies schema + `schema_migrations` + audit chain. Runbook section added.
- Backup/restore drill with `scripts/backup.sh` → `backup_runs` evidence.
- `RELEASE_CHECKLIST.md`: `LIVE_TRADING_ENABLED=false` verified (config test + env), every regulatory
  placeholder listed as **pending Sponsor acceptance** (never marked accepted on the Sponsor's behalf).

## 3. Test plan / final gate
build, lint, typecheck, test, test:integration (×2), test:e2e (×3), py:check, evals, i18n:check,
contrast, Storybook axe, Semgrep, pnpm audit, pip-audit, secrets scan, chaos run, load run.

## 4. Risks
- Breadth: many items; each gets a test or evidence file rather than prose.
- Authz matrix calls every route: side effects must stay inside a throwaway DB (`kora_test`).
- Load numbers on a shared cloud VM are noisy: report the environment and repeat runs.
- Adding spans to the hot order path must not cost latency: measured in the load run.

## 5. Backlog triage for goal 10
Done here (quality/security/operability): B-004, B-209, B-312 (contract surface), B-006 (re-check
under load), B-012, B-916, B-758 (dashboards/alerts), B-015, B-207 (load run; multi-replica stays
deployment), B-405/B-805 (Lighthouse), B-507, B-603 (tracing part), B-902, B-002 (server-side
revocation part). Re-targeted post-RC with reason: product features (B-402, B-406, B-407, B-409,
B-410, B-612, B-705, B-706, B-707, B-751–B-757, B-761, B-802, B-806, B-807, B-904–B-907, B-909,
B-912, B-915), deployment-only (B-001, B-008, B-201, B-302, B-315, B-610, B-903, B-913), Sponsor-data
(B-204, B-307, B-604, B-703, B-759), and design changes (B-304, B-308/B-803, B-310, B-311, B-605,
B-606, B-702, B-708, B-804/B-908).

## 6. Results
_Filled in at the end of the goal._
