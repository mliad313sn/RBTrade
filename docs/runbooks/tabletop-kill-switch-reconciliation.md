# Tabletop exercise — kill switch fired + reconciliation break

| Field | Value |
|---|---|
| Date | 2026-09-26 (run at 23:05 UTC) |
| Scenario | A reconciliation break (cash cache ≠ ledger) is detected; the 2nd line halts the firm (scope 3), fixes the book and resumes under four-eyes |
| Environment | **Local stack**: native Postgres :55432 (dev database `kora`), Redis :56379, built api (`apps/api/dist/main.js`) on :4020 with the in-process SIMULATED feed. PAPER only |
| Script | [`apps/api/scripts/tabletop-kill-switch-recon.mjs`](../../apps/api/scripts/tabletop-kill-switch-recon.mjs) (re-runnable; prints the evidence log below) |
| Runbooks exercised | [reconciliation break](reconciliation-break.md), [kill switch fired](kill-switch-fired.md), [incident workflow](incident-workflow.md) |
| Participants (roles played by the script) | trader (1st line), risk officer A (incident lead, 2nd line), risk officer B (independent approver, 2nd line), internal auditor (3rd line) |
| Facilitator / reviewers | S8 (risk and compliance, lead), S9 (security), S3 (architecture) |
| Incident | INC-000002 (exercise flag set; an earlier dry run created INC-000001) |

## Objectives and results

| # | Objective | Result |
|---|---|---|
| 1 | A reconciliation break is detected and reaches the risk console in ≤ 5 s | **Met**: critical `reconciliation.mismatch` on the `risk:alerts` channel 26 ms after the run started |
| 2 | The incident is logged from the alert and classified with the ITIL 4 matrix | **Met**: INC-000002 logged with the alert id, P1 (high × high) |
| 3 | The firm-wide kill switch (scope 3) halts, cancels and flattens within 2 s | **Met**: 3 accounts halted, 1 order cancelled, 2 positions flattened, 0 failures, 60 ms; `kill_switch.fired` (critical) on the console after 67 ms |
| 4 | The book is repaired from its source of truth under change control; reconciliation is clean again | **Met**: cash cache re-derived from the ledger; re-run shows 0 mismatches |
| 5 | Resuming a firm halt needs two people; the requester cannot approve | **Met**: resume answered 202; self-approval 403; duplicate request 409; approval by risk officer B resumed the account with both names audited |
| 6 | A P1 cannot close without a post-incident review | **Met**: close without a reference 400 `review_required`; closed with this document as the review |
| 7 | Internal audit can verify and evidence the exercise | **Met**: new signed anchor valid and in chain; chain valid (140 events); KC-07, KC-17, KC-20, KC-25 exported as CSV with SHA-256; KC-17 sampled with a seed |

## Evidence log (pasted from the run)

The injected fault is an owner-level change to one test account's **cached** cash (the ledger was not
touched), made on purpose for the exercise and recorded below. Ids are real rows in the dev database.

Run 2026-09-26T23:05:09.100Z against the local stack: api `dist/main.js` on :4020, dev database `kora` (Postgres :55432), Redis :56379, in-process SIMULATED feed. PAPER only.

### T+1.3 s — Set-up: participants and positions (1st line)

- trader `da4b6d3b-aa40-4a45-ad4e-3ff5afeded04`, risk officer A `085c7377-e8f5-4553-aec4-94e522469251`, risk officer B `6a7cfa83-ee40-44e0-a7f8-6cd00ddc6c5f`, auditor `66c91bb0-94f7-4a1a-af0b-307aa0c28d6d`
- order buy 0.2 BTCUSD market: HTTP 201 → filled
- order buy 3 ETHUSD market: HTTP 201 → filled
- order buy 0.05 BTCUSD limit @ 62900.0: HTTP 201 → working
- trader account `08d3b185-226c-4cd1-8bc8-050b5b169a0c`: equity 99976.96 USD, 2 open positions

### T+8.1 s — Risk officer A opens the console (live channel risk:alerts)

- subscribed to `risk:alerts` as risk officer A

### T+8.6 s — Detect: a reconciliation break is injected and found

- INJECTED (owner, exercise only): cached cash of `08d3b185-226c-4cd1-8bc8-050b5b169a0c` 99977.71 → +1000.00 (the ledger is untouched)
- reconciliation run `64b2146c-a52a-4679-bc2e-4439073f785b`: 3 accounts, mismatches: [{"accountId":"08d3b185-226c-4cd1-8bc8-050b5b169a0c","kind":"cash","engine":"100977.71","broker":"99977.71"}]
- console received `reconciliation.mismatch` (critical) 26 ms after the run started: "Reconciliation found 1 mismatch(es) between engine positions/cash and the ledger replay."

### T+8.6 s — Log and classify the incident (ITIL 4)

- logged INC-000002 (`39e2bead-a117-4fa2-879e-cbace8799521`), status logged
- classified P1 (impact high × urgency high)

### T+8.7 s — Contain: firm-wide kill switch (scope 3) from the console

- HTTP 202: 3 accounts halted, 1 orders cancelled, 2 positions flattened, 0 failures, 60 ms (global id `b0e5e562-455b-4576-a2fa-c5f2f782e229`)
- console received `kill_switch.fired` for the trader account 67 ms after the request (critical)
- trader state: halted=true, scope=robots_cancel_flatten, haltedBy=`085c7377-e8f5-4553-aec4-94e522469251`, resumeNeedsApproval=true
- trader positions after flatten: 0

### T+9.3 s — Investigate and resolve (2nd line + engineering, runbook reconciliation-break)

- evidence: cached cash 100956.07696 vs ledger 99956.07696 → the cache is wrong, the ledger is right (runbook step 3)
- fix (owner, under change control): cached cash reset to the ledger sum (runbook step 4)
- re-run reconciliation: 0 mismatch(es) left on the account (total run mismatches: 0)
- incident INC-000002 resolved

### T+9.3 s — Recover: resume needs four eyes (firm halt)

- trader asks to resume: HTTP 202, request `8db626ce-ce5a-4223-b0cd-669e8dc51923` (pending)
- trader tries to approve their own request: HTTP 403 (forbidden)
- risk officer A tries to open a second request: HTTP 409 (four_eyes_pending)
- risk officer B approves: HTTP 200, status approved, requestedBy `da4b6d3b-aa40-4a45-ad4e-3ff5afeded04`, decidedBy `6a7cfa83-ee40-44e0-a7f8-6cd00ddc6c5f`
- trader state: halted=false

### T+9.4 s — Post-incident review and closure

- close without a review reference: HTTP 400 (review_required)
- closed INC-000002 with review docs/runbooks/tabletop-kill-switch-reconciliation.md

### T+9.4 s — 3rd line: verification, anchors, evidence and sampling

- anchor #2: head 139 1340cde370267a7c…, signature true, in chain true
- auditor verifies: chain valid=true, 140 events, anchors 2 (bad 0)
- evidence KC-07 CSV: HTTP 200, 2 rows, sha256 99cb9cb1a9250b0a…
- evidence KC-17 CSV: HTTP 200, 4 rows, sha256 d85fd59d94c19d08…
- evidence KC-20 CSV: HTTP 200, 4 rows, sha256 aa3c6608a7f6ebdd…
- evidence KC-25 CSV: HTTP 200, 2 rows, sha256 933fd4b883eebb64…
- sample KC-17 (seed tabletop): 3 of 8 kill-switch events: #44 kill_switch.requested, #54 kill_switch.completed, #120 kill_switch.requested
- audit trail of the exercise:
  - `four_eyes.approved` × 1
  - `four_eyes.requested` × 1
  - `governance.evidence_exported` × 4
  - `incident.classified` × 1
  - `incident.closed` × 1
  - `incident.logged` × 1
  - `incident.resolved` × 1
  - `internal_audit.anchor_created` × 1
  - `internal_audit.chain_verified` × 1
  - `internal_audit.sample_drawn` × 1
  - `kill_switch.completed` × 3
  - `kill_switch.requested` × 3
  - `kill_switch.resumed` × 1
  - `kill_switch.robots_halted` × 3
  - `reconciliation.mismatch` × 1
  - `reconciliation.run` × 2
  - `risk.global_kill_switch` × 2

Total duration 9.4 s. Alerts received on the console: 4.
(dev clean-up: 2 other exercise-halted dev account(s) released by the owner.)

The backup and restore test run straight after the exercise (control KC-26):

```
[backup] dumping kora → /home/user/RBTrade/.data/backups/kora-20260926T230518Z.dump
[backup] ok: 269456 bytes, sha256 7df0bfbd9382e55ef197a2682a2cb4970e06dcf7213c9c86a4d957b36e9007b4 (backup_runs 40ecfdcb-026a-4e43-8751-f148db6bf155)
[restore-test] restoring into kora_restore_test
[restore-test] true: 11 tables, 234 rows compared, restored audit head aedd5a74f688f275… (backup_runs 32a90178-e417-4557-b024-6b992c1a4616)
```

## Post-incident review (exercise)

**Summary.** A deliberate difference between one account's cached cash and its ledger was found by an
on-demand reconciliation within a second and shown on the risk console. The 2nd line logged a P1,
halted the firm with the scope-3 kill switch (60 ms for 3 accounts), re-derived the cache from the
ledger, confirmed a clean reconciliation and resumed the account with an independent approver.

**What went well.**
- Detection and delivery are fast (26 ms and 67 ms from the triggering request to the console frame).
- The ledger/fills being append-only made the right answer unambiguous (cache wrong, ledger right).
- Four-eyes held at every attempt (self-approval, duplicate request) and the audit trail names both people.
- Internal audit could reproduce the evidence (CSV hashes, seeded sample) without write access.

**What to improve (actions).**

| # | Action | Owner | Target | Backlog |
|---|---|---|---|---|
| 1 | The firm-wide halt also halted two unrelated dev accounts; their owners are not present to request a resume. Add a bulk "resume all accounts of this firm halt" four-eyes request (one requester, one approver, per-account audit) | S8 / S4 | goal 10 | B-907 |
| 2 | Reconciliation found the break only because it was run on demand; the 60 s schedule would have found it within a minute. Page the risk officer on duty for `reconciliation.mismatch` outside the console (B-311/B-804 path) | S10 | goal 10 | B-908 |
| 3 | Data corrections are run by the database owner from the runbook. Provide a reviewed, audited admin command for "re-derive cash cache from the ledger" so no hand-written SQL is needed | S4 | goal 10 | B-909 |
| 4 | Repeat the exercise with a flatten that stays pending (closed venue) and with the bot runner live | S10 | quarterly | B-910 |

**Sign-off (exercise):** S8 (lead), S9, S3 — 2026-09-26.
