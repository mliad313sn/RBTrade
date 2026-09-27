# KORA control matrix

> Generated from `apps/api/src/governance/controls/catalogue.ts` by `pnpm --filter @kora/api control-matrix` (also writes `control-matrix.xlsx`). Do not edit by hand: a unit test fails when this file and the catalogue differ.

Goal 09 control framework aligned with COBIT 2019 (governance and management objectives) and ITIL 4 (incident management), with the Three Lines of Defence reflected in roles and tooling. Every control names an **automated evidence source that is implemented**: `GET /governance/controls/{id}/evidence?from&to&format=json|csv|pdf` (roles risk_officer, auditor, admin; audited as `governance.evidence_exported`) and the risk console export button produce it for any period.

- **Owner line:** 1st line = the business and technology teams that run the process (trader, quant, engineering, operations); 2nd line = risk and compliance (`risk_officer`); 3rd line = internal audit (`auditor`, read-only).
- **COBIT 2019 references** are a mapping aid, not a certification claim; the 2nd line confirms them against the licensed publication (OQ-G1).
- **No regulatory values** appear here. Figures such as retention periods, loss limits and disclosure percentages stay placeholders owned in `docs/open-questions.md`.

## Coverage

| Area | Controls |
|---|---|
| Access and MFA | KC-01, KC-02, KC-03, KC-04 |
| Segregation of duties (four-eyes) | KC-05, KC-06, KC-07, KC-08 |
| Change management | KC-09, KC-10, KC-11 |
| Audit-log integrity | KC-12, KC-13, KC-14 |
| Pre-trade risk limits | KC-15, KC-16, KC-17, KC-18, KC-19 |
| Reconciliation | KC-20 |
| AI oversight | KC-21, KC-22 |
| Data retention and protection | KC-23, KC-24 |
| Incident management | KC-25 |
| Backup and restore | KC-26 |
| Compliance hooks | KC-27, KC-28, KC-29, KC-30 |
| Independent assurance | KC-31 |

## Summary

| ID | Control | COBIT 2019 | Owner line | Frequency | Nature | Evidence |
|---|---|---|---|---|---|---|
| KC-01 | MFA enforced for every privileged role | DSS05.04 | 1st line | continuous | preventive, automated | query |
| KC-02 | Privileged role changes recorded, four-eyes approved and reviewed | DSS05.04, DSS06.03 | 1st line | quarterly | detective, semi-automated | log |
| KC-03 | Failed sign-in monitoring and lockout | DSS05.04, DSS05.07 | 1st line | daily | detective, automated | query |
| KC-04 | Internal auditor independence (role segregation) | DSS06.03, MEA04 | 2nd line | continuous | preventive, automated | query |
| KC-05 | Four-eyes risk sign-off before robot promotion | DSS06.03, BAI06.01 | 2nd line | per event | preventive, automated | query |
| KC-06 | Four-eyes on loosening risk limits above the platform default | DSS06.03, APO12.06 | 2nd line | per event | preventive, automated | query |
| KC-07 | Four-eyes on resuming trading after a firm halt | DSS06.03, APO12.06 | 2nd line | per event | preventive, automated | query |
| KC-08 | Four-eyes on MFA resets, disclosure publications and privileged role grants, with independent approvers | DSS05.04, MEA03.02 | 2nd line | per event | preventive, automated | query |
| KC-09 | Strategy changes are versioned, attributed and immutable | BAI06.01, BAI06.04 | 1st line | per event | preventive, automated | query |
| KC-10 | Database changes through forward-only, checksummed migrations | BAI06.03, BAI10 | 1st line | per event | preventive, automated | query |
| KC-11 | Releases carry a build identifier and an approval reference | BAI07, BAI06.01 | 1st line | per event | detective, automated | log |
| KC-12 | Hash-chain verification of the audit log | DSS06.05, MEA02.01 | 2nd line | daily | detective, automated | report |
| KC-13 | Signed anchors of the audit head (external digest) | DSS06.05, MEA04 | 3rd line | daily | detective, automated | query |
| KC-14 | Append-only records cannot be changed by the application | DSS06.05, DSS06.06 | 1st line | continuous | preventive, automated | query |
| KC-15 | Pre-trade risk limits block breaching orders | APO12.06, DSS06.02 | 1st line | continuous | preventive, automated | query |
| KC-16 | Novice guardrails enforced server-side | DSS06.02, MEA03.02 | 1st line | continuous | preventive, automated | query |
| KC-17 | Kill switch available and fast | APO12.06, DSS04 | 1st line | per event | corrective, automated | log |
| KC-18 | Robots auto-pause on loss and drawdown limits | APO12.06 | 1st line | continuous | corrective, automated | query |
| KC-19 | Risk alerts reach the 2nd line and are acknowledged | APO12.03, MEA01.04 | 2nd line | daily | detective, automated | query |
| KC-20 | Positions and cash reconciled every 60 seconds | DSS06.02, DSS06.04 | 1st line | every 60 s | detective, automated | query |
| KC-21 | AI suggests, a human decides | EDM03.02, APO12.06, MEA01.04 | 2nd line | weekly | preventive, automated | query |
| KC-22 | AI requests logged with model, prompt hash and guard flags | DSS06.05, MEA01.04 | 1st line | weekly | detective, automated | log |
| KC-23 | Record retention schedule monitored | APO14, DSS06.05 | 2nd line | monthly | detective, automated | report |
| KC-24 | Subject-access requests answered and logged | APO14, MEA03.02 | 2nd line | per event | detective, automated | log |
| KC-25 | Incidents detected, logged, classified, resolved and reviewed (ITIL 4) | DSS02.02, DSS02.05, DSS02.06, DSS03 | 1st line | per event | corrective, semi-automated | query |
| KC-26 | Backups taken and restores tested | DSS04.07, APO14 | 1st line | daily | corrective, automated | query |
| KC-27 | Risk warning acknowledged before the first order | MEA03.02 | 2nd line | continuous | preventive, automated | query |
| KC-28 | Appropriateness assessment before trader access | MEA03.02, DSS06.03 | 2nd line | continuous | preventive, automated | query |
| KC-29 | Best-execution monitoring | MEA03.03, MEA01.04 | 2nd line | monthly | detective, automated | report |
| KC-30 | LIVE trading stays disabled without a compliance sign-off | EDM03.02, MEA03.01 | 2nd line | continuous | preventive, automated | query |
| KC-31 | Independent control testing by internal audit | MEA02.02, MEA04 | 3rd line | quarterly | detective, semi-automated | log |

## Controls

### Access and MFA

#### KC-01 — MFA enforced for every privileged role

| Field | Value |
|---|---|
| Objective | Only users who pass TOTP MFA can use trader, quant, risk officer, auditor or admin capabilities. |
| COBIT 2019 | DSS05.04 |
| Risk addressed | Account takeover of a privileged user leads to unauthorised trading, limit changes or data access. |
| Owner | 1st line: Security engineering (S9) / platform admin |
| Frequency | continuous |
| Nature | preventive, automated |
| Automated evidence (query) | user_roles × user_mfa: privileged users and MFA state; auth.login / auth.mfa_failed audit events in the period |
| Evidence export | `GET /governance/controls/KC-01/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `auth.login`, `auth.mfa_failed`, `auth.mfa_enrolled` |

Test procedure:

1. Export the evidence for the period; confirm "privileged users without enabled MFA" is 0 or each exception is a user who has not signed in since the role was granted.
2. Re-perform: call a privileged API with a token issued without the otp claim and confirm 403 mfa_required (automated in test/auth.int.test.ts).
3. Sample 10 auth.login events of privileged users and confirm the payload records MFA.

#### KC-02 — Privileged role changes recorded, four-eyes approved and reviewed

| Field | Value |
|---|---|
| Objective | Every grant or removal of a role is attributable and reviewed each quarter; granting admin, risk officer, auditor or trader needs a second admin and a reason, and nobody grants themselves a role. |
| COBIT 2019 | DSS05.04, DSS06.03 |
| Risk addressed | Unreviewed privilege creep gives users capabilities outside their duties. |
| Owner | 1st line: Platform admin, reviewed by Risk & Compliance |
| Frequency | quarterly |
| Nature | detective, semi-automated |
| Automated evidence (log) | admin.roles_changed audit events in the period with the four-eyes request, requester and approver; privileged grants without four-eyes (must be 0); self-granted roles now (must be 0); current roster of privileged roles |
| Evidence export | `GET /governance/controls/KC-02/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `admin.roles_changed`, `appropriateness.passed` |

Test procedure:

1. Export the evidence for the quarter; confirm "privileged grants without four-eyes" and "self-granted roles now" are 0, and trace every role change to a ticket or approval.
2. Compare the roster with the HR joiner/mover/leaver list; any unmatched privileged user is an exception.
3. Re-perform: an admin granting risk_officer gets 202 and a pending role_grant request; they cannot approve it, a risk officer cannot approve it, a second admin can; an admin adding a role to themselves gets 403 self_grant (test/role-grants.int.test.ts).

#### KC-03 — Failed sign-in monitoring and lockout

| Field | Value |
|---|---|
| Objective | Repeated failed sign-ins lock the account and are visible to security. |
| COBIT 2019 | DSS05.04, DSS05.07 |
| Risk addressed | Password guessing or credential stuffing goes unnoticed. |
| Owner | 1st line: Security engineering (S9) |
| Frequency | daily |
| Nature | detective, automated |
| Automated evidence (query) | auth.login_failed audit events per day and reason; users currently locked |
| Evidence export | `GET /governance/controls/KC-03/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `auth.login_failed` |

Test procedure:

1. Export the evidence; investigate any day with an unusual count of bad_password failures.
2. Re-perform: 5 bad passwords lock the account (automated in test/lockout.int.test.ts).

#### KC-04 — Internal auditor independence (role segregation)

| Field | Value |
|---|---|
| Objective | The 3rd-line auditor role is never combined with an operating role. |
| COBIT 2019 | DSS06.03, MEA04 |
| Risk addressed | An auditor who can also trade or approve reviews their own work. |
| Owner | 2nd line: Risk & Compliance (S8) |
| Frequency | continuous |
| Nature | preventive, automated |
| Automated evidence (query) | user_roles: auditors and any auditor holding trader/quant/risk_officer/admin (must be 0; also refused by trigger user_roles_sod) |
| Evidence export | `GET /governance/controls/KC-04/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `admin.roles_changed` |

Test procedure:

1. Export the evidence; confirm the conflict count is 0.
2. Re-perform: an admin role change combining auditor with trader is refused (API 400 and database trigger).

### Segregation of duties (four-eyes)

#### KC-05 — Four-eyes risk sign-off before robot promotion

| Field | Value |
|---|---|
| Objective | A robot can be promoted only after a risk officer who is not its owner signs its exact limits. |
| COBIT 2019 | DSS06.03, BAI06.01 |
| Risk addressed | An owner promotes an untested or over-risked robot without independent review. |
| Owner | 2nd line: Risk officer |
| Frequency | per event |
| Nature | preventive, automated |
| Automated evidence (query) | robot_risk_signoffs and robot_promotions in the period with owner, signer and outcome; signer = owner count (must be 0) |
| Evidence export | `GET /governance/controls/KC-05/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `robot.risk_signed`, `robot.promotion_blocked` |

Test procedure:

1. Export the evidence; confirm "signed by owner" is 0.
2. Sample 5 promotions and confirm each passed only with a sign-off bound to the current limits hash.
3. Re-perform: an owner who is also a risk officer cannot sign their own robot (test/governance-four-eyes.int.test.ts).

#### KC-06 — Four-eyes on loosening risk limits above the platform default

| Field | Value |
|---|---|
| Objective | Raising an account limit above the platform default needs a requester and a different approver. |
| COBIT 2019 | DSS06.03, APO12.06 |
| Risk addressed | One person raises limits and exposes the firm to losses beyond appetite. |
| Owner | 2nd line: Risk officer |
| Frequency | per event |
| Nature | preventive, automated |
| Automated evidence (query) | four_eyes_requests (limit_override) in the period with requester, approver, status; requester = approver count (must be 0) |
| Evidence export | `GET /governance/controls/KC-06/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `four_eyes.requested`, `four_eyes.approved`, `four_eyes.rejected`, `account.limit_override_applied` |

Test procedure:

1. Export the evidence; confirm every approved override has an approver different from the requester and from the account holder.
2. Re-perform: the requester approving their own request gets 403 four_eyes; the database trigger refuses it too.

#### KC-07 — Four-eyes on resuming trading after a firm halt

| Field | Value |
|---|---|
| Objective | A halt set by the firm (risk officer or global kill switch) is lifted only by two people. |
| COBIT 2019 | DSS06.03, APO12.06 |
| Risk addressed | A single person lifts a firm-wide halt before the cause is understood. |
| Owner | 2nd line: Risk officer |
| Frequency | per event |
| Nature | preventive, automated |
| Automated evidence (query) | kill_switch.resumed audit events in the period: firm halts must carry a four-eyes request id with approver ≠ requester |
| Evidence export | `GET /governance/controls/KC-07/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `kill_switch.resumed`, `four_eyes.approved` |

Test procedure:

1. Export the evidence; confirm "firm resumes without four-eyes" is 0.
2. Re-perform: POST /kill-switch/resume on a firm halt returns 202 and the requester cannot approve it.

#### KC-08 — Four-eyes on MFA resets, disclosure publications and privileged role grants, with independent approvers

| Field | Value |
|---|---|
| Objective | Resetting a user’s second factor, publishing regulatory text or figures and granting a privileged role need two people, and the approver’s own approval role was not granted or approved by the requester. |
| COBIT 2019 | DSS05.04, MEA03.02 |
| Risk addressed | Social-engineered MFA reset; unreviewed disclosure text or figures shown to customers. |
| Owner | 2nd line: Risk & Compliance (S8) with platform admin |
| Frequency | per event |
| Nature | preventive, automated |
| Automated evidence (query) | four_eyes_requests (mfa_reset, disclosure_publish, role_grant) in the period with requester, approver and outcome; decisions whose approver role was granted or approved by the requester (must be 0) |
| Evidence export | `GET /governance/controls/KC-08/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `auth.mfa_reset`, `disclosure.published`, `disclosure.value_set`, `admin.roles_changed` |

Test procedure:

1. Export the evidence; confirm each approved request has a distinct approver and "approver role granted by requester" is 0.
2. Confirm each published disclosure version has approved_by ≠ drafted_by (disclosure_documents).
3. Re-perform: a user whose risk_officer role the requester granted cannot approve that requester (403 approver_not_independent, test/role-grants.int.test.ts).

### Change management

#### KC-09 — Strategy changes are versioned, attributed and immutable

| Field | Value |
|---|---|
| Objective | Every robot strategy change is a new immutable version with author, reason and content hash. |
| COBIT 2019 | BAI06.01, BAI06.04 |
| Risk addressed | Untraceable changes to automated trading logic. |
| Owner | 1st line: Strategy owner (trader / quant) |
| Frequency | per event |
| Nature | preventive, automated |
| Automated evidence (query) | strategy_versions created in the period (author, reason, hash) + presence of the immutability trigger |
| Evidence export | `GET /governance/controls/KC-09/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `strategy.version_created`, `robot.version_changed` |

Test procedure:

1. Export the evidence; confirm every version has an author and a reason, and the trigger is present.
2. Sample 5 versions and confirm the running robot version matches an audited strategy.version_created event.

#### KC-10 — Database changes through forward-only, checksummed migrations

| Field | Value |
|---|---|
| Objective | Schema changes are applied only by reviewed migration files whose checksums cannot change. |
| COBIT 2019 | BAI06.03, BAI10 |
| Risk addressed | Ad-hoc schema changes bypass review and break controls (e.g. drop an immutability trigger). |
| Owner | 1st line: Engineering (S3) |
| Frequency | per event |
| Nature | preventive, automated |
| Automated evidence (query) | schema_migrations ledger (version, name, sha256, applied_at), flagged when applied in the period |
| Evidence export | `GET /governance/controls/KC-10/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `system.release_started` |

Test procedure:

1. Export the evidence; match each migration applied in the period to a merged, reviewed pull request.
2. Confirm the migration runner refuses a modified applied file (test coverage in the runner).

#### KC-11 — Releases carry a build identifier and an approval reference

| Field | Value |
|---|---|
| Objective | Every api start records the build SHA and the deployment approval reference. |
| COBIT 2019 | BAI07, BAI06.01 |
| Risk addressed | Unapproved builds reach an environment unnoticed. |
| Owner | 1st line: Release manager (S10) |
| Frequency | per event |
| Nature | detective, automated |
| Automated evidence (log) | system.release_started audit events in the period (build SHA, approval reference, environment) |
| Evidence export | `GET /governance/controls/KC-11/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `system.release_started` |

Test procedure:

1. Export the evidence; every production release has a non-empty approval reference that matches the deployment approval record.
2. Releases without an approval reference outside dev/test are exceptions.

### Audit-log integrity

#### KC-12 — Hash-chain verification of the audit log

| Field | Value |
|---|---|
| Objective | The append-only audit log is verified end to end; any tamper is detected with the first broken id. |
| COBIT 2019 | DSS06.05, MEA02.01 |
| Risk addressed | Altered or deleted audit records hide misconduct or errors. |
| Owner | 2nd line: Risk & Compliance (S8); tested by internal audit |
| Frequency | daily |
| Nature | detective, automated |
| Automated evidence (report) | AuditService.verify(): {valid, count, firstBrokenId, headHash} + events recorded in the period |
| Evidence export | `GET /governance/controls/KC-12/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `internal_audit.chain_verified` |

Test procedure:

1. Export the evidence; confirm valid = true and the head hash matches the latest signed anchor (KC-13).
2. Re-perform: a tamper (trigger disabled by the owner) is detected (test/audit.int.test.ts).

#### KC-13 — Signed anchors of the audit head (external digest)

| Field | Value |
|---|---|
| Objective | The head hash is signed and written outside the database at least daily, so a rewrite of the chain is detectable. |
| COBIT 2019 | DSS06.05, MEA04 |
| Risk addressed | A privileged insider rewrites the whole chain consistently. |
| Owner | 3rd line: Internal audit |
| Frequency | daily |
| Nature | detective, automated |
| Automated evidence (query) | audit_anchors in the period with the signature checked against the pinned anchor keys (never the key stored in the row), untrusted keys, match against the current chain, whether the chain was truncated or rewritten after the latest trusted anchor, and the WORM copy read back (KORA_AUDIT_ANCHOR_DIR) |
| Evidence export | `GET /governance/controls/KC-13/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `internal_audit.anchor_created` |

Test procedure:

1. Export the evidence; confirm one anchor per day, every signature valid under a pinned key, untrusted keys 0, every anchored hash present in the chain, "truncated/mismatch after last anchor" false and WORM invalid-or-missing 0.
2. Re-perform: an anchor an insider signs with their own key is reported invalid (test/internal-audit.int.test.ts); a deleted tail makes /audit/verify return truncated_after_anchor (src/governance/anchors.unit.test.ts).

#### KC-14 — Append-only records cannot be changed by the application

| Field | Value |
|---|---|
| Objective | The runtime database role cannot update or delete audit, ledger, fill, acknowledgement or approval records. |
| COBIT 2019 | DSS06.05, DSS06.06 |
| Risk addressed | An application bug or compromise rewrites history. |
| Owner | 1st line: Engineering (S3) / Security (S9) |
| Frequency | continuous |
| Nature | preventive, automated |
| Automated evidence (query) | pg catalog: kora_app privileges on audit_events and immutability triggers on append-only tables |
| Evidence export | `GET /governance/controls/KC-14/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | — (population is the evidence table) |

Test procedure:

1. Export the evidence; confirm UPDATE/DELETE privileges are false and every listed trigger is present and enabled.

### Pre-trade risk limits

#### KC-15 — Pre-trade risk limits block breaching orders

| Field | Value |
|---|---|
| Objective | Orders that would breach notional, position, leverage, margin, loss or rate limits are rejected before they reach the engine. |
| COBIT 2019 | APO12.06, DSS06.02 |
| Risk addressed | Losses beyond appetite from a single order or a runaway strategy. |
| Owner | 1st line: Trading technology (S4); monitored by the risk officer |
| Frequency | continuous |
| Nature | preventive, automated |
| Automated evidence (query) | orders rejected in the period by risk code + risk.limit_breach alerts |
| Evidence export | `GET /governance/controls/KC-15/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `order.rejected` |

Test procedure:

1. Export the evidence; review the rejection mix for unusual patterns.
2. Re-perform: each risk code has a negative unit test (packages/domain risk.test.ts) and an API test.

#### KC-16 — Novice guardrails enforced server-side

| Field | Value |
|---|---|
| Objective | Guarded users trade market + stop only, without borrowing, with cooling-off and delayed loosening. |
| COBIT 2019 | DSS06.02, MEA03.02 |
| Risk addressed | Retail customers take risks they do not understand. |
| Owner | 1st line: Product (S1) with Risk & Compliance |
| Frequency | continuous |
| Nature | preventive, automated |
| Automated evidence (query) | guardrail rejections (NOVICE_*, MONTHLY_LOSS_LIMIT, DISCLOSURE_NOT_ACKNOWLEDGED) and guarded loosening requests in the period |
| Evidence export | `GET /governance/controls/KC-16/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `account.settings_updated`, `order.rejected` |

Test procedure:

1. Export the evidence; review repeated cooling-off triggers per user for conduct follow-up.
2. Re-perform: test/novice-guardrails.int.test.ts.

#### KC-17 — Kill switch available and fast

| Field | Value |
|---|---|
| Objective | The kill switch halts robots, cancels and flattens within 2 s, with every child action audited. |
| COBIT 2019 | APO12.06, DSS04 |
| Risk addressed | A runaway robot or market event cannot be stopped quickly. |
| Owner | 1st line: Trading technology (S4) |
| Frequency | per event |
| Nature | corrective, automated |
| Automated evidence (log) | kill_switch.completed audit events in the period with duration, cancelled and flattened counts |
| Evidence export | `GET /governance/controls/KC-17/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `kill_switch.requested`, `kill_switch.completed` |

Test procedure:

1. Export the evidence; confirm every durationMs is below 2,000.
2. Re-perform: test/kill-switch.int.test.ts (1,000 orders + 4 positions) and the tabletop exercise.

#### KC-18 — Robots auto-pause on loss and drawdown limits

| Field | Value |
|---|---|
| Objective | A running robot pauses itself when its daily, weekly or drawdown limit is reached. |
| COBIT 2019 | APO12.06 |
| Risk addressed | An automated strategy keeps trading through its loss limits. |
| Owner | 1st line: Strategy owner; monitored by the risk officer |
| Frequency | continuous |
| Nature | corrective, automated |
| Automated evidence (query) | robot.* alerts in the period (auto-pause reason, robot, detail) |
| Evidence export | `GET /governance/controls/KC-18/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `robot.auto_paused` |

Test procedure:

1. Export the evidence; confirm each auto-pause stayed paused until a human restarted it.
2. Re-perform: test/robots.int.test.ts auto-pause case.

#### KC-19 — Risk alerts reach the 2nd line and are acknowledged

| Field | Value |
|---|---|
| Objective | Breach, kill-switch, robot and reconciliation alerts reach the risk console within 5 s and are acknowledged. |
| COBIT 2019 | APO12.03, MEA01.04 |
| Risk addressed | Alerts are raised but nobody acts on them. |
| Owner | 2nd line: Risk officer |
| Frequency | daily |
| Nature | detective, automated |
| Automated evidence (query) | alerts in the period with severity, kind, created and acknowledged times (time to acknowledge) |
| Evidence export | `GET /governance/controls/KC-19/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `risk.alert_acknowledged` |

Test procedure:

1. Export the evidence; critical alerts unacknowledged after 1 business day are exceptions.
2. Re-perform: test/risk-console.int.test.ts (breach alert over the WebSocket in < 5 s).

### Reconciliation

#### KC-20 — Positions and cash reconciled every 60 seconds

| Field | Value |
|---|---|
| Objective | Engine positions and cash are compared with an independent replay of fills and the ledger; breaks raise critical alerts. |
| COBIT 2019 | DSS06.02, DSS06.04 |
| Risk addressed | Book errors go unnoticed and customers see wrong balances. |
| Owner | 1st line: Trading operations; breaks reviewed by the risk officer |
| Frequency | every 60 s |
| Nature | detective, automated |
| Automated evidence (query) | reconciliation_runs in the period (runs, accounts checked, mismatches, longest gap between runs) |
| Evidence export | `GET /governance/controls/KC-20/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `reconciliation.run`, `reconciliation.mismatch` |

Test procedure:

1. Export the evidence; confirm the longest gap between scheduled runs is under 5 minutes during operating hours.
2. For each run with mismatches, trace the alert, the incident and its resolution.

### AI oversight

#### KC-21 — AI suggests, a human decides

| Field | Value |
|---|---|
| Objective | The copilot only creates drafts; a person accepts or rejects each, and orders from drafts are placed by the user. |
| COBIT 2019 | EDM03.02, APO12.06, MEA01.04 |
| Risk addressed | Automated advice executes without human judgement. |
| Owner | 2nd line: Risk & Compliance (S8) with AI engineering (S7) |
| Frequency | weekly |
| Nature | preventive, automated |
| Automated evidence (query) | ai.draft / ai.draft_accepted / ai.draft_rejected counts and orders with source ai-draft-accepted (actor must be a user) |
| Evidence export | `GET /governance/controls/KC-21/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `ai.draft`, `ai.draft_accepted`, `ai.draft_rejected` |

Test procedure:

1. Export the evidence; confirm "AI-draft orders placed by a non-user actor" is 0.
2. Review the acceptance rate trend; a sudden rise is a conduct signal.

#### KC-22 — AI requests logged with model, prompt hash and guard flags

| Field | Value |
|---|---|
| Objective | Every AI call is attributable (model id from configuration, prompt hash, tokens, guard flags). |
| COBIT 2019 | DSS06.05, MEA01.04 |
| Risk addressed | AI output cannot be reconstructed or its failures noticed. |
| Owner | 1st line: AI engineering (S7) |
| Frequency | weekly |
| Nature | detective, automated |
| Automated evidence (log) | ai.request audit events in the period by surface and model id, with flagged answers |
| Evidence export | `GET /governance/controls/KC-22/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `ai.request`, `ai.tool_call` |

Test procedure:

1. Export the evidence; review flagged answers and confirm each was withheld or corrected.
2. Confirm no hard-coded model id (the model comes from KORA_AI_MODEL).

### Data retention and protection

#### KC-23 — Record retention schedule monitored

| Field | Value |
|---|---|
| Objective | Each record class has a retention period (placeholder until Compliance sets it) and nothing is purged early. |
| COBIT 2019 | APO14, DSS06.05 |
| Risk addressed | Records are lost before the regulatory period, or kept longer than allowed. |
| Owner | 2nd line: Compliance (S8) |
| Frequency | monthly |
| Nature | detective, automated |
| Automated evidence (report) | Retention report: per record class, period (or placeholder), count and oldest record |
| Evidence export | `GET /governance/controls/KC-23/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | — (population is the evidence table) |

Test procedure:

1. Export the evidence; confirm every class with a set period has no record older than it unless on legal hold, and placeholders are listed in open questions (OQ-R4).

#### KC-24 — Subject-access requests answered and logged

| Field | Value |
|---|---|
| Objective | A user’s personal data can be exported on request; each export is audited. |
| COBIT 2019 | APO14, MEA03.02 |
| Risk addressed | Data-protection requests are missed or answered incompletely. |
| Owner | 2nd line: Compliance / data protection |
| Frequency | per event |
| Nature | detective, automated |
| Automated evidence (log) | privacy.subject_access_exported audit events in the period (self-service or on behalf, sections exported) |
| Evidence export | `GET /governance/controls/KC-24/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `privacy.subject_access_exported` |

Test procedure:

1. Export the evidence; match each request in the privacy mailbox to an export within the deadline set by Compliance.

### Incident management

#### KC-25 — Incidents detected, logged, classified, resolved and reviewed (ITIL 4)

| Field | Value |
|---|---|
| Objective | Every incident follows the workflow; P1/P2 incidents close only with a post-incident review. |
| COBIT 2019 | DSS02.02, DSS02.05, DSS02.06, DSS03 |
| Risk addressed | Incidents recur because causes are not reviewed. |
| Owner | 1st line: Operations / SRE (S10) |
| Frequency | per event |
| Nature | corrective, semi-automated |
| Automated evidence (query) | incidents in the period with state timestamps, priority and review reference |
| Evidence export | `GET /governance/controls/KC-25/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `incident.logged`, `incident.classified`, `incident.resolved`, `incident.closed` |

Test procedure:

1. Export the evidence; confirm every closed P1/P2 has a review reference and time to resolve is recorded.
2. Sample 3 incidents and read the post-incident review.

### Backup and restore

#### KC-26 — Backups taken and restores tested

| Field | Value |
|---|---|
| Objective | The database is backed up daily and a restore is tested at least monthly. |
| COBIT 2019 | DSS04.07, APO14 |
| Risk addressed | Data cannot be recovered after corruption or loss. |
| Owner | 1st line: Operations / SRE (S10) |
| Frequency | daily |
| Nature | corrective, automated |
| Automated evidence (query) | backup_runs in the period (backups and restore tests, size, checksum, rows checked, result) |
| Evidence export | `GET /governance/controls/KC-26/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | — (population is the evidence table) |

Test procedure:

1. Export the evidence; confirm one successful backup per day and at least one successful restore test in the month.
2. Re-perform scripts/backup.sh against a scratch database.

### Compliance hooks

#### KC-27 — Risk warning acknowledged before the first order

| Field | Value |
|---|---|
| Objective | A novice acknowledges the risk warning version and figures in force before any order adds exposure. |
| COBIT 2019 | MEA03.02 |
| Risk addressed | Customers trade without having seen the required warning. |
| Owner | 2nd line: Compliance (S8) |
| Frequency | continuous |
| Nature | preventive, automated |
| Automated evidence (query) | acknowledgements in the period by version and jurisdiction + novice orders placed before any acknowledgement (must be 0) |
| Evidence export | `GET /governance/controls/KC-27/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `disclosure.acknowledged` |

Test procedure:

1. Export the evidence; confirm the violation count is 0 for orders after the gate went live.
2. Retrieve 5 acknowledgements through /compliance/acknowledgements and confirm verified = true.

#### KC-28 — Appropriateness assessment before trader access

| Field | Value |
|---|---|
| Objective | The trader role is granted only after a passed, versioned appropriateness assessment. |
| COBIT 2019 | MEA03.02, DSS06.03 |
| Risk addressed | Customers get complex products without an appropriateness check. |
| Owner | 2nd line: Compliance (S8) |
| Frequency | continuous |
| Nature | preventive, automated |
| Automated evidence (query) | users holding trader without a passed appropriateness attempt (must be 0) + attempts in the period |
| Evidence export | `GET /governance/controls/KC-28/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `appropriateness.passed`, `appropriateness.failed`, `admin.roles_changed` |

Test procedure:

1. Export the evidence; each exception must be a four-eyes role_grant flagged appropriatenessOverride, with a documented reason (KC-02 evidence).
2. Re-perform: an admin granting trader without a reason gets 400; with a reason it becomes a pending role_grant approved by a second admin; a Keycloak token carrying trader without a passed attempt is stripped of it.

#### KC-29 — Best-execution monitoring

| Field | Value |
|---|---|
| Objective | Slippage against the reference price is measured by instrument and hour and reviewed. |
| COBIT 2019 | MEA03.03, MEA01.04 |
| Risk addressed | Customers systematically get worse prices than the market. |
| Owner | 2nd line: Compliance / best-execution committee |
| Frequency | monthly |
| Nature | detective, automated |
| Automated evidence (report) | fills in the period: count, mean / median / p95 slippage in price units and bps, adverse share, by instrument |
| Evidence export | `GET /governance/controls/KC-29/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | — (population is the evidence table) |

Test procedure:

1. Export the evidence; investigate instruments whose adverse share or p95 slippage stands out.

#### KC-30 — LIVE trading stays disabled without a compliance sign-off

| Field | Value |
|---|---|
| Objective | No LIVE account or robot exists and the LIVE flag stays off until the Sponsor’s sign-off. |
| COBIT 2019 | EDM03.02, MEA03.01 |
| Risk addressed | Real money is traded before legal and regulatory approval. |
| Owner | 2nd line: Sponsor / Compliance |
| Frequency | continuous |
| Nature | preventive, automated |
| Automated evidence (query) | LIVE accounts, LIVE robots, active compliance sign-offs and the runtime LIVE flag |
| Evidence export | `GET /governance/controls/KC-30/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `robot.promotion_blocked` |

Test procedure:

1. Export the evidence; confirm LIVE accounts = 0, LIVE robots = 0 and the flag is false.

### Independent assurance

#### KC-31 — Independent control testing by internal audit

| Field | Value |
|---|---|
| Objective | Internal audit samples evidence per control and exports it for its working papers. |
| COBIT 2019 | MEA02.02, MEA04 |
| Risk addressed | Controls are assumed to work without independent testing. |
| Owner | 3rd line: Internal audit |
| Frequency | quarterly |
| Nature | detective, semi-automated |
| Automated evidence (log) | internal_audit.sample_drawn and governance.evidence_exported audit events in the period |
| Evidence export | `GET /governance/controls/KC-31/evidence?from=…&to=…&format=csv\|pdf` |
| Sampling audit actions | `internal_audit.sample_drawn`, `governance.evidence_exported` |

Test procedure:

1. Export the evidence; confirm every control was sampled at least once in the audit cycle.
