# /goal 09 — Risk, compliance and governance layer

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, all ADRs.

## Goal
Make KORA governable and audit-ready. It should have a documented control framework aligned with COBIT 2019 and ITIL 4, the Three Lines of Defence reflected in roles and tooling, and the product hooks a regulated broker or partner will require. This goal builds **controls and evidence**. It does not give legal advice: every regulatory value stays a placeholder until Compliance confirms it.

## Scope
1. **Control matrix (`docs/governance/control-matrix.xlsx` + `.md`).** For each control: id, objective, COBIT 2019 objective reference (e.g. APO12, BAI06, DSS05, MEA03), risk addressed, owner line (1st / 2nd / 3rd), frequency, automated evidence source (query, report, log), test procedure.

   Cover at least:
   - access and MFA;
   - segregation of duties (four-eyes on robot promotion, limit changes, kill-switch resume);
   - change management (versioned strategies, PR reviews, deploy approvals);
   - audit-log integrity;
   - pre-trade risk limits;
   - reconciliation;
   - AI oversight;
   - data retention;
   - incident management;
   - backup and restore.
2. **Risk officer console** (role `risk_officer`, 2nd line):
   - firm-wide exposure and loss vs limits;
   - limit breaches;
   - bots near auto-pause;
   - pending four-eyes approvals;
   - kill-switch history;
   - reconciliation breaks;
   - AI suggestion accept/reject rates;
   - a one-click evidence export (CSV/PDF) for any control and period.
3. **Internal audit view** (3rd line): read-only access to the audit log with hash-chain verification, sampling tools (random N events per control), and export.
4. **Compliance hooks:**
   - a disclosures registry (versioned text, jurisdiction, effective date, placeholder values) with user acknowledgements stored;
   - a suitability / appropriateness questionnaire engine (goal 08 knowledge checks feed into it);
   - a KYC provider interface as a stub only;
   - best-execution report data (slippage stats by instrument and time);
   - record-keeping retention policy config.
5. **Operational resilience:**
   - service level objectives (SLOs) and runbooks in `docs/runbooks/` for feed outage, engine stall, reconciliation break, AI provider outage, kill switch fired, and database restore;
   - an incident workflow aligned with ITIL 4 (detect → log → classify → resolve → post-incident review template).
6. **Data protection:**
   - data classification;
   - PII minimisation, encryption at rest and in transit;
   - retention schedules;
   - subject-access and export endpoints.

## Acceptance criteria
- [ ] Every control in the matrix names a working automated evidence source, and the export produces it for a chosen date range (test for 5 sample controls).
- [ ] Four-eyes is enforced: the same user cannot request and approve (API tests for promotion, limit loosening and kill-switch resume).
- [ ] The risk console shows real data from goals 03 and 06, and breach alerts reach the console within 5 s.
- [ ] The disclosure version in force at the time of each acknowledgement can be retrieved for any user.
- [ ] Runbooks exist for all 6 scenarios, and a tabletop test of "kill switch fired + reconciliation break" is documented.
- [ ] `docs/open-questions.md` lists every regulatory placeholder with an owner, and the STATUS update is done.
