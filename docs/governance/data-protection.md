# Data protection

Goal 09. Owner: Compliance / data protection (S8) with Security (S9). Scope: the KORA platform as
built (PAPER, SIMULATED market data). This document describes what the system does; it is not legal
advice. Retention periods, lawful bases and notification deadlines are placeholders owned in
`docs/open-questions.md` (OQ-R4, OQ-P1, OQ-P2, OQ-A1).

## 1. Classification

| Class | Meaning | Examples in KORA | Handling |
|---|---|---|---|
| **C4 Secret** | Credentials and keys; disclosure = compromise | password hashes (scrypt), TOTP secrets, JWT/anchor signing keys, service token, AI API key | never exported, never logged (pino redaction), TOTP secrets AES-256-GCM at rest, keys only from env/vault |
| **C3 Confidential — personal** | Identifies a person or their behaviour | e-mail, display name, roles, IP in audit payloads, orders/fills/positions/ledger per account, questionnaire scores, acknowledgements, AI drafts | access by owner, 2nd line and 3rd line only; exported on subject access; minimised to the AI provider |
| **C3 Confidential — regulated record** | Must be kept and unaltered | audit log, fills, ledger, acknowledgements, four-eyes approvals, incidents | append-only (triggers + runtime role without UPDATE/DELETE); retention schedule |
| **C2 Internal** | Operational data | alerts, reconciliation runs, release records, metrics | 2nd/3rd line and operations |
| **C1 Public** | Published by design | SIMULATED market data, public reliability page (labelled), disclosures text | no restriction; licences apply to real data (OQ-M3/OQ-M4) |

## 2. PII inventory and minimisation

| Data | Where | Why it is needed | Minimisation |
|---|---|---|---|
| E-mail, display name | `users` | sign-in, contact | no phone, address or date of birth collected; KYC is a stub (OQ-K1) |
| Password | `users.password_hash` | authentication | scrypt hash only; never returned by any endpoint |
| TOTP secret | `user_mfa.totp_secret_enc` | MFA | encrypted with AES-256-GCM (`KORA_MFA_ENC_KEY`); reset only through four-eyes (B-003) |
| IP address | `auth.*` audit payloads | security monitoring (KC-03) | only on authentication events |
| Trading activity | `orders`, `fills`, `positions`, `ledger_entries` | the service itself; record-keeping | keyed by account id; no free text except optional kill-switch/resume reasons |
| Assessments | `questionnaire_attempts` | appropriateness, knowledge, suitability | **answers are never stored**, only scores |
| AI interactions | `ai_order_drafts`, `ai_strategy_drafts`, `ai.request` events | oversight (KC-21/22) | prompts sent to the provider carry a pseudonymous user ref; e-mails, phones, IBANs and card numbers redacted; no names or account ids (goal 07, OQ-A1) |

## 3. Encryption

| Where | At rest | In transit |
|---|---|---|
| Postgres | disk/volume encryption of the managed service (deployment, goal 10); TOTP secrets additionally AES-256-GCM in the application | **TLS required outside dev/test**: the api refuses a `DATABASE_URL` without `sslmode=require|verify-ca|verify-full` (goal 09 config check) |
| Redis | managed-service encryption (deployment) | **TLS required outside dev/test**: `rediss://` enforced by the same check |
| Backups | `pg_dump` files written `0600` in a `0700` directory with SHA-256 recorded (`scripts/backup.sh`); production: encrypted object storage with object lock (goal 10) | copied over TLS |
| Audit anchors | signed (ES256) head digests in `audit_anchors` + a JSON-lines file for WORM storage | — |
| Browser ↔ web ↔ api | — | HTTPS with HSTS at the edge (goal 10, B-015); HttpOnly, Secure, SameSite cookies outside dev; CSP with nonce |
| api ↔ AI provider | — | HTTPS (official SDK) |

The escape hatch `KORA_ALLOW_INSECURE_TRANSPORT=true` exists only for a local docker compose stack.

## 4. Retention schedule

Implemented in `apps/api/src/governance/retention.ts`, reported by `GET /governance/retention` and
evidenced by control KC-23. **Periods are placeholders** until Compliance sets them (OQ-R4); `null`
means "retain, no automatic deletion". Market-data ticks keep their 7-day technical retention.

| Record class | Classification | Period | Disposal |
|---|---|---|---|
| Audit log | regulated record | placeholder (OQ-R4) | never deleted by the application; archive to WORM |
| Orders, fills, ledger | regulated record | placeholder (OQ-R4) | archive after the period |
| Disclosure acknowledgements, assessments, four-eyes approvals | regulated record | placeholder (OQ-R4) | archive after the period |
| Incidents, alerts, reconciliation runs | operational | placeholder (OQ-R4) | archive |
| User profiles | personal data | account lifetime + a period after closure (OQ-P1) | pseudonymise; regulated records keep the pseudonymous id |
| AI forecasts | operational | placeholder (OQ-R4) | archive |
| News articles | licensed content | per licence (OQ-M4) | delete per licence |
| Market-data ticks and 1 s bars | market data (SIMULATED) | 7 days | deleted by the feed |

Conflict rule: where a person asks for erasure but a record-keeping obligation applies, the regulated
record is kept for its period and the profile is pseudonymised (decision for Compliance, OQ-P1).

## 5. Data-subject rights

| Right | Implementation |
|---|---|
| Access / portability | `GET /me/data-export` (self-service JSON) and `GET /compliance/subject-access/{userId}` (risk officer/admin on behalf); both audited `privacy.subject_access_exported` (KC-24). Secrets are excluded. |
| Rectification | display name and preferences in Settings; e-mail changes through support (no self-service yet) |
| Erasure | not automated: regulated records have retention duties (OQ-P1); profile pseudonymisation is a Compliance decision |
| Restriction / objection | no profiling or automated decisions with legal effect; the suitability profile records answers and produces no recommendation |

Response deadlines and identity checks for requests are set by Compliance (OQ-P2).

## 6. Breach handling

A personal-data incident is logged as category `security` (P1/P2) and follows the incident workflow;
notification duties and deadlines depend on the jurisdictions (OQ-R2, OQ-O2) and go through the
Sponsor.
