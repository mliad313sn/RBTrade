# Release checklist — KORA 1.0.0-rc.1

Release candidate RC-1, PAPER only. Prepared by the Project Owner with S10 (QA/SRE), S9 (security)
and S3 (architecture) on 2026-09-27 (goal 10). Every box below links to its evidence. Nothing in this
file accepts a regulatory value, a licence or a risk on the Sponsor's behalf: those rows say
**pending Sponsor acceptance** until the Sponsor signs them.

## 1. Safety switches

- [x] **`LIVE_TRADING_ENABLED=false` confirmed.**
  - `.env.example` line 9: `LIVE_TRADING_ENABLED=false`; CI (`ci.yml`) and the release pipeline
    (`release.yml`) pin `LIVE_TRADING_ENABLED: "false"`; the staging deploy step refuses any `true`.
  - The api refuses to start with `LIVE_TRADING_ENABLED=true` (`apps/api/src/config/config.test.ts`
    "refuses LIVE_TRADING_ENABLED=true"); so does the bot runner (`services/bot-runner/src/runner.test.ts`).
  - `GET /health` reports `environment: "PAPER", liveTradingEnabled: false` (e2e `auth.spec.ts`).
  - Semgrep rule in `.semgrep.yml` blocks code that switches it on; no broker adapter exists (OQ-B1).
  - Promote-to-LIVE stays refused while the flag is false (goal 06/09 tests).
- [x] All market data, news, accounts and fees are labelled SIMULATED in the product.
- [x] Kill switch works through REST with Redis down (`docs/qa/chaos.md`), under robot load in
  83–179 ms (`docs/qa/load.md`).

## 2. Quality gates (goal 10 acceptance)

| Gate | Evidence | State |
|---|---|---|
| lint, types, unit (+ coverage gates), integration (×2), contracts, e2e (×3), AI evals, i18n, a11y (axe on every route + Storybook), security scans | `docs/plans/10-release.md` §6 (final gate log) | see §6 |
| Coverage ≥ 85 % on domain logic | `docs/qa/coverage.md` | done |
| Golden-path e2e (7 flows) | `apps/web/e2e/golden-path.spec.ts` and module specs, mapped in plan §6 | done |
| Chaos: feed, Redis, quant, AI provider | `docs/qa/chaos.md`, `docs/qa/chaos/` (logs, screenshots) | done |
| Load: 500 users, 200 symbols, 50 bots, 100 orders/s | `docs/qa/load.md` — all goal 02/03 targets and SLO-2/3 pass; exceptions E-1, E-2 | exceptions pending Sponsor (OQ-O3) |
| Security: 0 open critical/high, threat model | `docs/security/scans.md`, `docs/security/threat-model.md`, `docs/security/authz-matrix.md` | done (ZAP deferred to staging, Trivy in CI) |
| Traces ticket → fill; alerts link runbooks | `apps/api/test/tracing.int.test.ts`, `apps/api/test/observability.int.test.ts`, `infra/prometheus/alerts.yml`, `infra/grafana/` | done |
| Accessibility WCAG 2.2 AA | `docs/qa/a11y.md` | done |

## 3. Release mechanics

- [x] Version `1.0.0-rc.1` in every workspace package, the OpenAPI document and the api
  (`API_VERSION`); quant `1.0.0rc1` (PEP 440).
- [x] `CHANGELOG.md` generated from the Conventional Commit history.
- [x] Staging deploy pipeline with manual approval: `.github/workflows/release.yml` (full CI →
  images + Trivy → `staging` environment with required reviewers → PAPER smoke check → ZAP baseline).
  Sets `KORA_BUILD_SHA` and `KORA_RELEASE_APPROVAL_REF` (control KC-11).
  - [ ] **Sponsor/ops:** create the `staging` environment with required reviewers and its secrets; provide
    `/srv/kora/deploy.sh` on the staging host (contract in the workflow). Not verifiable here.
- [x] Database migration rollback tested (restore-based; migrations are forward-only, ADR 0001):
  `scripts/release/migration-rollback-test.mjs` → `docs/qa/release/migration-rollback.json`
  (failed migration atomic; after rollback schema, migrations, row counts and the 1,136-event audit
  chain are identical; roll forward clean; restore 0.9 s on the drill data).
- [x] Backup/restore drill: `scripts/backup.sh --db kora_e2e` → `docs/qa/release/backup-restore-2026-09-27.log`
  (backup + restore test rows in `backup_runs`, restored audit head found in the source chain).
  - [ ] **Ops:** managed PITR backups and the monthly restore test on staging/production (SLO-10/11).
- [x] Runbooks for every alert (`docs/runbooks/`), SLOs proposed (`docs/runbooks/slos.md`, OQ-O1).

## 4. Regulatory and policy placeholders

None of these is resolved by engineering. Each stays visible in the product as a placeholder or a
SIMULATED value until the Sponsor (or the named owner) supplies it. Source: `docs/open-questions.md`.

| ID | Placeholder | Status |
|---|---|---|
| OQ-R1 | Retail-loss percentage `[XX]%` | pending Sponsor acceptance |
| OQ-R2 | Launch jurisdictions | pending Sponsor acceptance |
| OQ-R3 | Retail/professional leverage limits | pending Sponsor acceptance |
| OQ-R4 | Record-retention periods (all `null` = retain) | pending Sponsor acceptance |
| OQ-R5 | Default pre-trade risk limits (`KORA_RISK_*`) | pending Sponsor acceptance |
| OQ-R6 | Paper starting cash and base currencies | pending Sponsor acceptance (proposed) |
| OQ-R7 | Default per-robot risk limits | pending Sponsor acceptance |
| OQ-R8 | Promote-to-LIVE thresholds and sign-off rules | pending Sponsor acceptance |
| OQ-B1 | Broker partner and adapter capabilities | pending Sponsor acceptance |
| OQ-B2 | Market data licensing | pending Sponsor acceptance |
| OQ-B3 | Margin close-out / margin-call policy | pending Sponsor acceptance |
| OQ-M1 | Margin rates by tier | pending Sponsor acceptance |
| OQ-M2 | Reference-data source and licence | pending Sponsor acceptance |
| OQ-M3 | Licensed market-data providers per region | pending Sponsor acceptance |
| OQ-M4 | Licensed news providers and AI-processing rights | pending Sponsor acceptance |
| OQ-M5 | Commission, swap and FX fee schedules | pending Sponsor acceptance |
| OQ-M6 | Round-trip cost assumptions for forecast skill | pending Sponsor acceptance |
| OQ-S1 | Production IdP and password policy (recovery codes done) | pending Sponsor acceptance |
| OQ-S2 | No self-service trader | **resolved** by the Sponsor (2026-09-26) |
| OQ-D1 | Prototype sources (PNG only) | pending Product Owner / Sponsor |
| OQ-D2 | Dark ink on buy/sell fills | **resolved** by the Sponsor (2026-09-26) |
| OQ-A1 | AI provider data-processing agreement | pending Sponsor acceptance |
| OQ-A2 | AI API key, model choice, prices, budgets; live evals | pending Sponsor acceptance |
| OQ-A3 | Release eval thresholds, novice copy review | pending Sponsor acceptance (proposed) |
| OQ-A4 | Public forecast track record wording | pending Sponsor acceptance (S8 reviewed for PAPER) |
| OQ-Q1 | Skill-free practice edge + retail-loss line | pending Sponsor acceptance (decided by S1 + S8) |
| OQ-Q2 | Overfitting statistics presentation | pending Sponsor acceptance (proposed) |
| OQ-C1 | Appropriateness assessment content | pending Sponsor acceptance |
| OQ-C2 | Suitability questionnaire and bands | pending Sponsor acceptance |
| OQ-N1 | Novice cooling-off thresholds | pending Sponsor acceptance |
| OQ-N2 | Novice borrowing cap | pending Sponsor acceptance |
| OQ-N3 | Onboarding loss-limit defaults, symmetric scenario | pending Sponsor acceptance (proposed) |
| OQ-N4 | Knowledge-check content | pending Sponsor acceptance |
| OQ-G1 | COBIT references and named control owners | pending Sponsor acceptance |
| OQ-G2 | Four-eyes policy parameters | pending Sponsor acceptance (proposed) |
| OQ-G3 | Risk console thresholds | pending Sponsor acceptance (proposed) |
| OQ-K1 | KYC provider and checks | pending Sponsor acceptance |
| OQ-P1 | Personal-data retention and erasure rule | pending Sponsor acceptance |
| OQ-P2 | Subject-access handling | pending Sponsor acceptance |
| OQ-O1 | SLOs and error-budget policy | pending Sponsor acceptance (proposed) |
| OQ-O2 | Incident and breach notification duties | pending Sponsor acceptance |
| OQ-O3 | Load-test exceptions E-1, E-2 | pending Sponsor acceptance |
| OQ-X1 | Best-execution policy | pending Sponsor acceptance |

## 5. Sponsor launch checklist (market launch gate — Sponsor only)

RC-1 is a release candidate for PAPER. Market launch additionally needs, from the Sponsor:

1. A licensed broker partner and a reviewed broker adapter (OQ-B1, B-302); only then may the Sponsor
   consider `LIVE_TRADING_ENABLED` with the goal 09 controls operating.
2. Market data and news licences per region, including redistribution and AI-processing rights
   (OQ-B2, OQ-M2–M4).
3. An AI API key and model choice from the vault (`ANTHROPIC_API_KEY`, `KORA_AI_MODEL`), prices and
   budgets, and a passing live eval run (`pnpm evals:live`, OQ-A2, B-703).
4. Every regulatory value in §4 supplied or explicitly accepted, per jurisdiction.
5. Legal sign-off per launch jurisdiction (disclosures, appropriateness, KYC, retention, incident duties).
6. Deployment verification: Keycloak realm (B-001), Docker images and compose/cluster, TLS, managed
   backups and PITR, object-lock storage for audit anchors (B-903), secrets in a vault.
7. A real GitHub Actions run of `ci.yml` and `release.yml` (never executed from this environment),
   including Trivy image scans and the ZAP baseline against staging.
8. Human copy reviews: novice EN/FR copy (B-808), AI explanations (OQ-A3), disclosures.
9. A third-party penetration test of staging.
10. Acceptance of the load-test exceptions (OQ-O3) after a re-run on staging hardware.
