# Plan 09 — Risk, compliance and governance layer

Lead seats: S8 (risk and compliance officer, lead), S9 (security engineer), S3 (software architect).
Gate lenses: S10 (quality), Project Owner.
Inputs: master goal (incl. the 2026-09-26 scope amendment), goal 09, charter, STATUS hand-overs
(goal 03: audit visibility B-303, reconciliation, kill switch; goal 06: four-eyes promotion; goal
07/07B: audit actions `ai.*`, `intel.*`, OQ-A4; goal 08: disclosures interface, acknowledgements,
first-order gate B-801, questionnaire engine, guarded limits), every ADR, BACKLOG items targeted to
09, `docs/open-questions.md`.

This goal builds **controls and evidence**. It gives no legal advice: every regulatory value stays an
explicit placeholder with an owner in `docs/open-questions.md`. Nothing here enables LIVE trading.

## 1. Decisions up front

| Topic | Decision | Why |
|---|---|---|
| Single source of truth for controls | The control catalogue is code: `apps/api/src/governance/controls/catalogue.ts` (id, objective, COBIT 2019 reference, risk, owner line, frequency, test procedure, evidence query). `docs/governance/control-matrix.md` **and** `.xlsx` are generated from it by `pnpm --filter @kora/api control-matrix` (committed generator, dependency-free OOXML writer). A unit test fails when the committed `.md` differs from the catalogue. | A matrix that drifts from the running evidence queries is worse than none. |
| Evidence export | `GET /governance/controls/:id/evidence?from&to&format=json\|csv\|pdf` (risk officer, auditor, admin). Every export is audited (`governance.evidence_exported`, with row count and the SHA-256 of the file) and carries `X-Kora-Evidence-Sha256`. PDF is written by a small dependency-free text PDF writer; CSV is RFC 4180 with formula-injection neutralisation. | Goal §2 "one-click evidence export"; no new supply-chain dependency (S9). |
| Three lines of defence | 1st line: `trader`, `quant` (and the platform's own automated controls). 2nd line: `risk_officer` (console, approvals, global kill switch). 3rd line: **new role `auditor`** (read-only: audit log, chain verification, anchors, sampling, evidence export). `admin` stays operations. Admin role changes refuse combining `auditor` with `trader`/`quant`/`risk_officer`/`admin` (SoD). Role added to the domain, DB check constraint (0090), Keycloak realm, MFA-required list. | Goal: "Three Lines of Defence reflected in roles and tooling". Needs an RBAC change → ADR 0009. |
| Four-eyes engine | One table `four_eyes_requests` (kind, subject, payload, requested_by, status, decided_by, …) with a DB trigger that refuses `decided_by = requested_by` for everyone, plus the same rule in the service (403 `four_eyes`). Kinds: `limit_override`, `kill_switch_resume`, `mfa_reset` (B-003), `disclosure_publish`. Robot promotion keeps its goal 06 tables and trigger (owner ≠ signer), surfaced in the same console queue. Every request/decision is audited (`four_eyes.requested/approved/rejected/cancelled`) and the approved action records both people. | Goal §1 SoD; one mechanism, tested once per kind. |
| Limit loosening | Platform limits (`KORA_RISK_*`) are the ceiling; accounts can only tighten their own limits (goal 03/08, unchanged). **Loosening above the platform limit** for an account (e.g. a professional client, OQ-R5) is a `limit_override` request: requested by the owner or a risk officer, approved by a *different* risk officer or admin, then stored in `accounts.limit_overrides` and applied by `AccountsService.limits()`. Guarded (Novice) users cannot request overrides. | Four-eyes on "limit changes" where it matters: above the firm's default. |
| Kill-switch resume | Policy `KORA_FOUR_EYES_RESUME` = `firm` (default) or `all`. `firm`: a halt set by someone other than the account owner (a risk officer on one account, or the **global kill switch**, B-314) needs a second person to resume: `POST /kill-switch/resume` answers `202 {pendingApproval}` and a different risk officer/admin approves. Self-imposed halts on one's own PAPER account resume as before. `all`: every resume needs four eyes (intended for LIVE). | Keeps goal 03 UX for self-halts; firm halts cannot be lifted by one person. |
| Global kill switch (B-314) | `POST /risk/kill-switch {scope, reason}` (risk officer/admin, MFA) runs the goal 03 engine on every account with the risk officer as actor; one parent audit event plus the per-account child events. | Needed for the tabletop and the console. |
| Breach alerts ≤ 5 s | All alerts stay in the goal 03 `alerts` table. Pre-trade limit rejections (limit codes) now also insert a `risk.limit_breach` alert inside the rejection transaction. An `AFTER INSERT` trigger `NOTIFY kora_alerts`; each api process LISTENs, de-duplicates on the alert id in Redis (`SET NX`), and publishes on the WS bus channel `risk:alerts` (risk officer/admin only). The console subscribes; REST polling (5 s) is the fallback. Test: WS message ≤ 5 s after the breach (integration) and on screen ≤ 5 s (e2e). | NOTIFY is delivered on commit (no phantom alerts), works across replicas. |
| Risk console | `GET /risk-console/overview` + web `/risk`: firm exposure and loss vs limits per account (valued by the goal 03 `AccountsService.view`), limit breaches, bots near auto-pause (goal 06 supervisor inputs vs limits, threshold `KORA_RISK_NEAR_PAUSE_PCT` 70 %), pending four-eyes approvals (incl. robot sign-offs), kill-switch history, reconciliation breaks, AI draft accept/reject rates, novice guardrail events (B-810), open incidents; approve/reject buttons; evidence export form. | Goal §2. |
| Internal audit view | `/internal-audit` (auditor, risk officer, admin): read-only audit browser, chain verification, signed anchors (B-007), random sampling `GET /internal-audit/sample?control&n&seed&from&to` (seeded, reproducible, the seed is in the result), CSV export. No write endpoints for the auditor except evidence exports (audited). | Goal §3. |
| Audit anchoring (B-007) | `POST /internal-audit/anchors` (admin, and a daily in-process job, `KORA_AUDIT_ANCHOR_INTERVAL_MS`) stores the head id + hash in `audit_anchors` with an ES256 signature (key from `KORA_AUDIT_ANCHOR_JWK`, ephemeral in dev) and appends a JSON line to `KORA_AUDIT_ANCHOR_DIR` (WORM stand-in). Verification recomputes the chain and checks every anchor's hash and signature. | ADR 0102 consequence; external WORM storage is a deployment item (goal 10). |
| B-303 | Owners read system-actor events about their own account/orders through `GET /audit` (`actor_id = me OR payload->>'accountId' = my account`), expression index added in 0090. | Hand-over from goal 03. |
| Disclosures registry | DB-backed, versioned, per jurisdiction: `disclosure_documents` (id, version, jurisdiction, locale texts, value keys, effective_from, status, drafted_by, approved_by) and `disclosure_values` (key, jurisdiction, value or NULL = placeholder, effective_from, owner, open-question ref). `DbDisclosureRegistry implements DisclosureRegistry` (same `current(id, locale)` interface, served from an in-memory snapshot refreshed on publish and every 60 s) replaces the config-backed one in `DisclosuresModule`; callers are untouched. Seeded from `risk-warning.v1.json` (jurisdiction `GLOBAL`, the retail-loss value NULL = `[XX]`, OQ-R1). Rendering and the content hash are the goal 08 functions, so goal 08 acknowledgements stay valid. `KORA_DISCLOSURE_RETAIL_LOSS_PCT` remains an override for dev/test only. New versions are drafted and published through four-eyes (`disclosure_publish`). | Goal §4; interface from ADR 0008 §5. |
| Version in force at acknowledgement | `GET /compliance/acknowledgements?userId=` (risk officer/auditor/admin) and `GET /me/acknowledgements`: each acknowledgement with the full document as it was, **re-rendered from the registry and verified against the stored content hash** (`verified: true`). | Acceptance 4. |
| First-order gate (B-801) | New pre-trade rule `DISCLOSURE_NOT_ACKNOWLEDGED` for novice-only users: an order that adds exposure is refused unless the latest risk-warning acknowledgement matches the version and values in force. Reduce-only/closing and kill-switch orders are never blocked. Code localised EN/FR. | B-801. |
| Suitability | `suitability.v1.json` (kind `suitability`, SIMULATED weights, OQ-C2) in the goal 03 questionnaire engine; `GET/POST /suitability(/attempts)`; `GET /me/suitability` and `GET /compliance/suitability/:userId` combine appropriateness (goal 03), the knowledge check (goal 08) and the suitability score into one profile with SIMULATED band names. No recommendation is produced. | Goal §4; B-313 partly. |
| KYC | `KycProvider` interface + `StubKycProvider` (flagged, refuses real checks, status `not_configured`); `GET /compliance/kyc/providers`, `GET /me/kyc`. | Goal §4 "stub only". |
| Best execution | `GET /compliance/best-execution?from&to&groupBy=instrument\|hour` → fills count, mean/median/p95 slippage in price units and bps vs the reference price, adverse share. From goal 03 `fills.slippage`/`reference_price`. | Goal §4. |
| Retention | `apps/api/src/governance/retention.ts`: record classes with a period (placeholder `null` = "retain until Compliance sets it", OQ-R4), legal basis placeholder, and the table/timestamp column; `GET /governance/retention` reports counts and oldest record per class (dry run, nothing is deleted; `md_trades`/`md_bars_1s` keep their goal 02 7-day technical retention). | Goal §4, §6. |
| Data protection | `docs/governance/data-protection.md` (classification, PII inventory, minimisation, encryption at rest/in transit, retention schedule). Implementation: subject-access export `GET /me/data-export` and `GET /compliance/subject-access/:userId` (JSON, audited `privacy.subject_access_exported`; secrets and hashes never exported); production config refuses a `DATABASE_URL` without `sslmode=require/verify-full` and a non-TLS `REDIS_URL` (`KORA_ALLOW_INSECURE_TRANSPORT=true` escape for local compose). TOTP secrets already AES-256-GCM (goal 01). | Goal §6 "where feasible". |
| Incidents (ITIL 4) | `incidents` table + `/governance/incidents` (detect → log → classify (P1–P4) → resolve → post-incident review, each transition audited; resolving P1/P2 requires a PIR link). Critical alerts can be promoted to an incident from the console. | Goal §5 and a real evidence source for the incident control. |
| Backup and restore | `scripts/backup.sh` (pg_dump custom format → restore into a scratch DB → row-count check → records a `backup_runs` row). Evidence query reads `backup_runs`. Run once in this session for evidence. | Control "backup and restore" needs a real source. |
| Release record | On boot the api records `system.release_started` (build SHA `KORA_BUILD_SHA`, approval reference `KORA_RELEASE_APPROVAL_REF`, environment). Change-management evidence = applied migrations (`schema_migrations`) + release events. | Change management evidence that the runtime can produce by itself. |
| B-014 | Sign-up answers `201 {accepted: true, mfaRequired: false}` for new **and** existing e-mails (same timing: the password is always hashed); a duplicate is audited `auth.signup_duplicate`. Clients read the id from `/me` after sign-in. Production uses Keycloak's verify-email flow (B-001). | S9 finding from G1. |
| B-202 | Registry columns `price_unit` (e.g. `GBX`, `ZAc`) and `price_unit_factor` (0.01); `priceMultiplier()` includes the factor; HSBA.XLON and NPN.XJSE quoted in minor units (SIMULATED prices scaled ×100); preview/notional in the major currency; the terminal shows the unit. | B-202 targeted to 09. |
| B-203 | WS gateway: per-user and per-IP connection quotas (`KORA_MD_WS_MAX_CONN_PER_USER`, `…_PER_IP`), and `{op:'auth', token}` on an open socket re-authenticates the same subject and re-arms the expiry timer (SDK refreshes before expiry). | B-203 targeted to 09. |

## 2. Files

- `apps/api/migrations/0090_governance.sql` (auditor role, four-eyes, limit overrides, alerts NOTIFY, audit index, anchors, incidents, backups, releases), `0091_disclosure_registry.sql`, `0092_minor_units.sql`.
- `packages/domain`: `roles.ts` (`auditor`, `AUDIT_READ_ROLES`, `GOVERNANCE_ROLES`, `rolesConflict`), `governance/` (four-eyes kinds and zod schemas, incident states, retention classes, CSV helpers), risk code `DISCLOSURE_NOT_ACKNOWLEDGED`, `priceMultiplier` factor.
- `apps/api/src/governance/`: module, `four-eyes.service.ts`, `approvals.controller.ts`, `controls/catalogue.ts`, `controls/evidence.service.ts`, `evidence.controller.ts`, `pdf.ts`, `xlsx.ts`, `csv.ts`, `control-matrix-cli.ts`, `risk-console.service.ts/controller.ts`, `alerts-bridge.service.ts`, `internal-audit.controller.ts`, `anchors.service.ts`, `incidents.*`, `retention.ts`, `release-record.service.ts`, `global-kill-switch`.
- `apps/api/src/compliance/`: disclosure registry (DB), publication, acknowledgement history, suitability, KYC stub, best execution, subject access.
- Edits: `KillSwitchService` (target account + actor, resume policy), `AccountsService.limits` (overrides), `OmsService` (breach alert, disclosure gate), `AuditController` (B-303, auditor), `DisclosuresModule` (provider swap), `DevIdpService.signup` (B-014), gateway (B-203, `risk:alerts`), admin roles (SoD), config (transport checks).
- `apps/web`: `/risk` console, `/internal-audit`, left-rail entries by role, route rules, halted banner pending-approval state, i18n keys for the new risk code.
- `scripts/backup.sh`, `apps/api/scripts/tabletop-kill-switch-recon.mjs` (tabletop runner; lives with the api so it can use `pg`/`ws`).
- Docs: `docs/governance/control-matrix.md/.xlsx`, `docs/governance/data-protection.md`, `docs/governance/three-lines.md`, `docs/runbooks/` (SLOs, 6 scenarios, ITIL 4 incident workflow, PIR template, tabletop record), ADR 0009, STATUS, BACKLOG B-901+, open questions (owners for every placeholder), README section, `.env.example`.

## 3. Test plan

- **Unit:** four-eyes rules, CSV neutralisation, PDF/XLSX writers (parse back), control catalogue completeness (every control has COBIT ref, owner line, frequency, evidence, test procedure; every listed area covered), matrix drift test, retention report, suitability profile, seeded sampler.
- **Integration (api):** `governance-four-eyes.int.test.ts` (promotion, limit loosening, kill-switch resume, MFA reset, disclosure publish: same user refused by API and by DB trigger; different user succeeds; audit trail names both); `governance-evidence.int.test.ts` (every control's evidence runs; CSV + PDF for 5 sample controls for a date range, rows inside the range only, export audited); `risk-console.int.test.ts` (overview with real goal 03/06 data; breach alert over WS ≤ 5 s; global kill switch); `internal-audit.int.test.ts` (auditor read-only, verify, anchors, sampling reproducible, B-303); `compliance.int.test.ts` (registry versions, acknowledgement history with verified text, B-801 gate, suitability, KYC stub, best execution, subject access, retention); auth B-014; WS B-203; B-202 multiplier.
- **e2e:** `governance.spec.ts`: risk officer console shows real data and a breach alert appears within 5 s; approve a four-eyes request as a second user; evidence CSV download; auditor verifies the chain and samples.
- **Tabletop:** "kill switch fired + reconciliation break" exercised against the local stack (dev DB :55432, api on a scratch port), evidence pasted in `docs/runbooks/tabletop-kill-switch-reconciliation.md`.
- Full gate: build, lint, typecheck, test, test:integration (twice), test:e2e, py:check, evals, i18n check.

## 4. Risks

- Scope is wide; controls must each have a *working* query — enforced by the "every control runs" test.
- NOTIFY listener needs a dedicated connection; reconnect on error, REST fallback on the console.
- Adding a role touches RBAC in several places — covered by role tests and the SoD rule.
- COBIT 2019 practice numbers are quoted from the public framework structure; the matrix says the 2nd line confirms them against the licensed publication.

## 5. Out of scope / deferred (reasons in §6.3 when done)

B-002 refresh tokens and session revocation (with Keycloak, B-001, goal 10), B-204 licensed reference data (Sponsor, OQ-M2), B-307 margin close-out (policy OQ-B3 unanswered), B-308/B-803 customer time zones, B-310 bid/ask FX, B-403/B-757 push delivery of price and radar alerts, B-605/B-606/B-702 robot segregation and live KPIs, B-756/B-806 translations, B-804 phone/email alerts.

## 6. Results

Commits on `claude/magical-newton-yyxga6` from `d5c7a7f` (plan) to the STATUS commit. Migrations
0090–0092. Everything PAPER and SIMULATED.

### 6.1 Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Every control names a working automated evidence source; the export produces it for a chosen date range (5 sample controls) | **Pass** | 31 controls, each with an implemented query (`governance.unit.test.ts`: no control without a query, no orphan query, matrix `.md`/`.xlsx` match the catalogue). `governance-evidence.int.test.ts`: every control's evidence runs for a period; CSV + PDF for **KC-06, KC-12, KC-15, KC-20, KC-27** contain the period's rows and nothing from an earlier period; each export audited with the file's SHA-256 (header = audit payload); roles and bad periods refused |
| 2 | Four-eyes enforced: the same user cannot request and approve (promotion, limit loosening, kill-switch resume) | **Pass** | `governance-four-eyes.int.test.ts` (7 tests): resume after a firm halt → 202, requester self-approval 403 `four_eyes`, DB trigger refuses `decided_by = requested_by`, second risk officer approves (audit names both); a risk officer cannot approve their own account's resume; limit override: requester and account holder refused, second risk officer applies it; robot owner/risk officer cannot sign own robot, another can; MFA reset (B-003) same rule. Goal 06 `promotion.int.test.ts` still green |
| 3 | Risk console shows real data from goals 03 and 06; breach alerts reach it within 5 s | **Pass** | `risk-console.int.test.ts`: overview exposure row equals the engine's `/accounts/me` numbers, breaches, reconciliation, approvals, robots, AI, novice panels; breach → WS `risk:alerts` frame **60 ms** after the order request (twice); non-2nd-line subscription `forbidden`. e2e `governance.spec.ts`: alert visible on `/risk` **57–61 ms** after the breach; firm kill switch by hold, four-eyes approval in the UI, KC-07 CSV download |
| 4 | The disclosure version in force at each acknowledgement can be retrieved for any user | **Pass** | `compliance.int.test.ts`: a user acknowledges v1 with `[XX]`, Compliance publishes 74 through four-eyes, the user must re-acknowledge (B-801 gate blocks the order until then), `/compliance/acknowledgements?userId=` returns both, each re-rendered from the registry with `verified: true` (content hash), the first shows `[XX]`, the second 74; future-dated v2 served only at its effective date; the value was restored to the placeholder |
| 5 | Runbooks for all 6 scenarios; tabletop "kill switch fired + reconciliation break" documented | **Pass** | `docs/runbooks/` (feed outage, engine stall, reconciliation break, AI provider outage, kill switch fired, database restore, SLOs, ITIL 4 workflow, PIR template). Tabletop run on the local stack (dev DB :55432, built api :4020): `docs/runbooks/tabletop-kill-switch-reconciliation.md` with the pasted log (mismatch alert on the console 26 ms, P1 incident, firm scope-3 halt 3 accounts in 60 ms, ledger fix, clean re-run, 202 → 403 self-approval → approval by a second risk officer, P1 close refused without review, anchors, evidence hashes, sample) |
| 6 | `docs/open-questions.md` lists every regulatory placeholder with an owner; STATUS updated | **Pass** | 42 rows (10 new: OQ-C2, G1–G3, K1, P1, P2, O1, O2, X1; OQ-R4 and OQ-A4 updated); unit test fails if the code references an `OQ-*` missing from the table or a row has no owner. STATUS G9 row + section |

### 6.2 Gate (all green)

| Check | Result |
|---|---|
| `pnpm build` | pass (7 tasks) |
| `pnpm lint` | pass (13 tasks) |
| `pnpm typecheck` | pass |
| `pnpm test` | pass — domain 183, api unit 149, web 62, ui 113, market-data 71, sdk 15, bot-runner 11, ai-evals 4 |
| `pnpm test:integration` (run 1) | **217 / 217** (34 files; +49 tests since goal 08: governance-four-eyes 7, governance-evidence 4, risk-console 3, internal-audit 5, compliance 7, ws-quotas 2, minor-units 2, plus existing suites adjusted for B-801/B-014) |
| `pnpm test:integration` (run 2) | **217 / 217**; kill switch 1,000 orders 165 ms; breach alert 60 ms |
| `pnpm test:e2e` | **54 / 54** (3.3 min; +2 `governance.spec.ts`) |
| `pnpm py:check` | pass — ruff, mypy --strict, 160 pytest, 97.4 % coverage |
| `pnpm evals` | 117 / 117 (100 %), PASS |
| `pnpm --filter @kora/web i18n:check` | pass (7 tests; `risk.DISCLOSURE_NOT_ACKNOWLEDGED` EN/FR, readability report regenerated) |
| Backup + restore test | `scripts/backup.sh` on the dev DB after the tabletop: dump 269,456 bytes (sha256 `7df0bfbd…`), restore test **true**, 11 tables / 234 rows compared, audit head in chain |

### 6.3 Deferred (with reason)

- **B-002** refresh tokens / session revocation → goal 10 with Keycloak (B-001).
- **B-003** MFA recovery codes → B-902 (the four-eyes reset shipped).
- **B-204** licensed reference data → post-RC, needs a Sponsor contract (OQ-M2).
- **B-307** margin close-out → blocked on the policy (OQ-B3).
- **B-308 / B-803** customer time zones, **B-310** bid/ask FX, **B-403 / B-757** push of price/radar alerts,
  **B-605 / B-606 / B-702** robot segregation and live KPIs, **B-756 / B-806** translations, **B-804**
  phone/e-mail alerts → goal 10 (engine or UX work outside the governance scope).
- **B-202 remainder** (NPN.XJSE in ZAc, Novice display) → B-901: NPN is a curated Novice asset and
  minor units need Novice copy first.
- UIs for disclosure drafting (B-905), suitability questionnaire (B-906), sign-off approval and incident
  classification in the console (B-904); APIs are complete.
- Tabletop actions B-907 … B-910; retention execution (B-911, needs OQ-R4/OQ-P1); KYC provider (B-914,
  Sponsor); WORM object-lock storage (B-903).

### 6.4 Committee review notes

- **S8:** no regulatory value was invented; every figure is a placeholder with an owner; the product
  never gives recommendations (suitability records answers only). OQ-A4 reviewed (acceptable for PAPER).
- **S9:** four-eyes enforced twice (service + trigger); auditor SoD twice (API + trigger); CSV injection
  neutralised; subject access excludes secrets; `risk:alerts` 2nd line only; WS quotas; TLS enforced
  outside dev/test; no new third-party dependency (PDF/XLSX writers are in-repo).
- **S3:** governance core module is global to avoid a trading ↔ governance cycle; the disclosures
  registry keeps the goal 08 interface; alert relay via NOTIFY survives multiple api replicas (Redis
  `SET NX` de-duplication).
