# ADR 0009 — Risk, compliance and governance layer

- Status: Accepted (2026-09-26)
- Deciders: S8 (risk and compliance, lead), S9 (security), S3 (architecture), S10, Project Owner
- Context: goal 09; hand-overs from goal 03 (audit visibility B-303, reconciliation, kill switch),
  goal 06 (four-eyes promotion), goal 07/07B (AI audit actions, OQ-A4), goal 08 (disclosures interface,
  acknowledgements, first-order gate B-801, questionnaire engine, guarded limits); BACKLOG items
  targeted to 09.
- Related: [plan 09](../plans/09-governance.md), [control matrix](../governance/control-matrix.md),
  [three lines](../governance/three-lines.md), [data protection](../governance/data-protection.md),
  [runbooks](../runbooks/README.md).

## Decisions

### 1. The control catalogue is code; the matrix is generated

`apps/api/src/governance/controls/catalogue.ts` holds 31 controls (objective, COBIT 2019 reference,
risk, owner line, frequency, nature, evidence source, test procedure, sampling audit actions).
`evidence-queries.ts` implements one evidence query per control. `pnpm --filter @kora/api
control-matrix` writes `docs/governance/control-matrix.md` and `.xlsx` (dependency-free OOXML writer,
deterministic zip). Unit tests fail if a control lacks a query, if a query is orphaned, or if the
committed files differ from the catalogue. COBIT references are a mapping aid confirmed by the 2nd
line against the licensed framework (OQ-G1), not a certification claim.

### 2. Evidence export per control and period, audited

`GET /governance/controls/{id}/evidence?from&to&format=json|csv|pdf` (risk officer, auditor, admin)
runs the query for `[from, to)` (≤ 366 days) and renders JSON, RFC 4180 CSV (formula-injection
neutralised) or a text PDF (dependency-free writer, standard fonts). Each export is audited
(`governance.evidence_exported`) with the SHA-256 of the file, also returned as `X-Kora-Evidence-Sha256`.
No PDF/XLSX library was added (supply chain, S9).

### 3. A third line: the `auditor` role

`ROLES` gains `auditor` (MFA required). It reads the whole audit log (`AUDIT_READ_ROLES`) and uses the
internal audit view and evidence export, but is **not** in `AUDIT_READ_ALL_ROLES` (account access,
resuming other accounts). SoD: an auditor cannot hold trader/quant/risk officer/admin (admin API 400 and
the `user_roles_sod` trigger). An auditor-only account stays novice-guarded if it ever places a paper
order and lands on `/internal-audit`.

### 4. One four-eyes engine

`four_eyes_requests` (kinds `limit_override`, `kill_switch_resume`, `mfa_reset`, `disclosure_publish`, `role_grant` — §4a)
with a single invariant — **the approver is never the requester** — enforced by `FourEyesStore` (403
`four_eyes`) and by the database (`four_eyes_guard` trigger, `four_eyes_distinct_approver` check);
decided rows are immutable, nothing is deleted, one pending request per subject, lazy expiry
(`KORA_FOUR_EYES_TTL_HOURS`). `FourEyesService` adds "not the person it is about" and executes the
approved action with both names audited. The goal 06 promotion sign-off keeps its own tables and
trigger and is shown in the same console queue. The store lives in a global `GovernanceCoreModule` so
the trading core can open a request (kill-switch resume) without a module cycle.

### 4a. Privileged role grants are four-eyes, and approvers must be independent (IRTC R4-02, R4-10)

Segregation of duties is only as strong as role assignment. Rules (2026-09-27, IRTC R4):

- **Role grants.** `PUT /admin/users/:id/roles` that *adds* `admin`, `risk_officer`, `auditor` or
  `trader` (`PRIVILEGED_GRANT_ROLES`) does not apply the change: it needs a `reason` and opens a
  `role_grant` four-eyes request (202). Only an **admin** other than the requester and other than the
  user concerned approves it; the approval applies the exact before→after change (refused if the roles
  moved since) and records `granted_by` (requester), `approved_by` and `four_eyes_request_id` on the
  new `user_roles` rows. Removals and `novice`/`quant` still apply directly.
- **No self-grants.** Nobody adds a role to themselves (403 `self_grant`; `user_roles_no_self_grant`
  and `user_roles_distinct_approver` constraints, migration 0121).
- **Approver independence (every kind).** A decision (approve *or* reject) is made through an approval
  role (`risk_officer`/`admin`; `admin` for role grants) that the requester neither granted nor
  approved, and that is older than `KORA_APPROVER_COOLING_HOURS` (default 24 h outside dev/test, 0 in
  dev/test). Otherwise 403 `approver_not_independent`. The check reads `user_roles`, not the token.
  **The relation is symmetric** (IRTC re-verification, 2026-09-27): the decider also may not have
  granted or approved any role of the requester (`requester_granted_by_decider`). Without it, an admin
  who once had a second admin approve a puppet's admin role could approve every request the puppet
  made. The goal 06 robot risk sign-off applies the same rule between the signer and the robot owner
  (refused at sign-off, and a sign-off by a non-independent signer does not satisfy the checklist).
- **Trader outside the assessment.** Passing the appropriateness assessment stays the normal path. An
  admin grant of `trader` is a `role_grant` with a reason; the request records
  `appropriatenessPassed` and, without a passed attempt, `appropriatenessOverride: true` (KC-28
  exceptions). With Keycloak, a token carrying `trader` without a local passed attempt is stripped of
  it for the request and in the local roles.
- **Bootstrap.** The first admins are created by the deployment runbook (database seed), not the API.
  With Keycloak, realm-role assignment for admin/risk_officer/auditor is governed in the IdP, whose own
  process must mirror this rule (open item for Security, see `docs/review/IRTC-R4-fixes.md`).
- **Evidence.** KC-02 reports privileged grants with and without four-eyes and self-granted rows; KC-08
  covers `role_grant` and counts decisions whose approver role the requester granted or approved.

### 5. Limit loosening = platform override with four eyes

Accounts still only tighten their own limits (goals 03/08). Raising a limit **above the platform
default** for one account is a `limit_override` request (owner or risk officer), approved by another
risk officer/admin who is not the account holder, stored in `accounts.limit_overrides` and applied by
`AccountsService.platformLimits()`. Guarded (novice) accounts cannot ask.

### 6. Firm halts need two people to resume

`KillSwitchService.triggerAccount(actor, account, …)` lets a risk officer halt any account; the global
kill switch (B-314, `POST /risk-console/kill-switch`) runs it on every active account. A halt set by
someone other than the holder is a **firm halt** (`halted_by` = the risk officer). With
`KORA_FOUR_EYES_RESUME=firm` (default) a firm halt answers `POST /kill-switch/resume` with `202` and a
pending request; `all` makes every resume four-eyes (intended for LIVE). Self-imposed halts keep the
goal 03 one-person resume. Every kill switch raises a `kill_switch.fired` alert.

### 7. Breach alerts reach the console in ≤ 5 s through NOTIFY

All alerts stay in the goal 03 `alerts` table; pre-trade rejections with limit codes
(`LIMIT_BREACH_CODES`) insert a `risk.limit_breach` alert inside the rejection transaction. An
`AFTER INSERT` trigger `pg_notify('kora_alerts', id)` fires on commit; each api process LISTENs
(`AlertsBridgeService`, reconnect with back-off), de-duplicates with Redis `SET NX` and publishes on the
bus channel `risk:alerts`, which the WS gateway serves to risk officers/admins only and never conflates.
Measured: ~60 ms from the order request to the console frame (integration test and e2e; budget 5 s).

### 8. Internal audit: verification, signed anchors (B-007), reproducible sampling

`/internal-audit/*` (auditor, risk officer, admin; read-only except for the audit events that record
what the auditor did). Anchors sign `{headId, headHash, eventCount, anchoredAt}` with ES256
(`KORA_AUDIT_ANCHOR_JWK`, required outside dev/test), are stored append-only and appended to a JSON-lines
file (`KORA_AUDIT_ANCHOR_DIR`, WORM stand-in; object-lock storage is a deployment item). Verification
checks each signature and that the anchored hash is still in the chain. Sampling uses a seeded PRNG over
the control's audit actions (or its evidence rows): same seed, same sample; the draw is audited.

### 9. Disclosures registry in the database, same interface

`DbDisclosureRegistry` implements goal 08's `DisclosureRegistry` (`current(id, locale)` stays
synchronous: an in-memory snapshot reloaded after each publication and every minute). Versions are per
jurisdiction (`GLOBAL` until OQ-R2) with an effective date; values (e.g. `retailLossPct`) have their own
effective dates and stay `NULL` = placeholder `[XX]` until Compliance publishes them. Publication (text
or value) is a `disclosure_publish` four-eyes request; published text is immutable (trigger).
Rendering and hashing are shared with the goal 08 code, so existing acknowledgements stay valid, and
`GET /compliance/acknowledgements` re-renders the exact version and values each acknowledgement was
bound to and re-verifies the content hash (`verified: true`).

### 10. First-order gate (B-801) as a pre-trade rule

`DISCLOSURE_NOT_ACKNOWLEDGED` in `evaluateRisk`: a novice-only user whose latest risk-warning
acknowledgement does not match the version and values in force cannot add exposure; reducing and
kill-switch orders always pass. A new figure therefore requires re-acknowledgement before the next
order.

### 11. Compliance hooks

Suitability is a third definition in the goal 03 questionnaire engine (`kind: suitability`, SIMULATED,
OQ-C2); the profile combines it with appropriateness and the knowledge check, stores scores only and
produces no recommendation. KYC is an interface with a flagged stub that refuses (OQ-K1). Best
execution reads goal 03 `fills.slippage` vs `reference_price` by instrument or UTC hour. Retention is a
policy table with placeholder periods and a dry-run report. Subject access exports a user's data as
JSON without secrets, audited. The ITIL 4 incident register enforces the workflow and a review
reference to close P1/P2.

### 12. Also in this goal

B-014 (generic sign-up response), B-202 (minor-unit quotes: `price_unit`/`price_unit_factor`, HSBA.XLON
in GBX), B-203 (WS per-user/per-IP quotas, token refresh on an open socket), B-303 (owners see system
events about their own account), TLS enforcement to Postgres/Redis outside dev/test, release record
(`system.release_started`) for change-management evidence, `scripts/backup.sh` with a restore test.

## Consequences

- Controls and their evidence cannot drift silently: adding a control means a query and a test.
- Firm halts are safer but slower to lift; a bulk resume request for a firm-wide halt is B-907.
- The NOTIFY relay needs one dedicated connection per api process; the console keeps a 5 s REST
  fallback. Alert volume is bounded by rejections and alerts, not by quotes.
- Regulatory values remain placeholders; the platform is ready to receive them through four-eyes
  publication without code changes.
- Trade-offs recorded as backlog: refresh tokens and session revocation (B-002 → goal 10), KYC
  provider (Sponsor), licensed reference data (B-204, Sponsor), customer time zones (B-308/B-803), margin
  close-out policy (B-307, OQ-B3).
