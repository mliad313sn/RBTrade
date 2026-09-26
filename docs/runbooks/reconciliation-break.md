# Runbook — reconciliation break

Category `reconciliation_break`. Default priority **P1** (book integrity in doubt). SLO-6. Controls:
KC-20 (reconciliation every 60 s), KC-19 (alerts acknowledged), KC-14 (append-only ledger/fills).
Owner: risk officer on duty (lead) with S4.

## What reconciliation compares

Every 60 s and on demand (`POST /reconciliation/run`), for each account, inside a REPEATABLE READ
snapshot (goal 03):

- engine `positions` vs an **independent replay of the fills** (the paper "broker" view): quantity and
  average price; orphan positions;
- cached `accounts.cash` vs the **ledger** cash balance; the whole ledger must sum to zero.

A mismatch writes a `reconciliation_runs` row, a **critical `reconciliation.mismatch` alert** (live on
the risk console) and an audit event. The ledger and the fills are append-only (triggers; the runtime
role cannot update or delete them), so they are the source of truth; `positions` and `accounts.cash`
are caches derived from them.

## Steps

1. **Acknowledge** the alert on the console and **log an incident** from it (`alertId`), classify
   (impact high × urgency high → P1 unless clearly cosmetic).
2. **Contain.** If positions may be wrong, stop new risk: kill switch on the affected account(s) or the
   firm-wide kill switch (scope 2: robots + cancel). Do not flatten on a wrong position view: fix the
   book first, then decide.
3. **Diagnose** from the alert details (`kind`, `engine`, `broker`, `symbol`):
   - `cash`: compare `accounts.cash` with `SUM(ledger_entries.amount) WHERE ledger_account = 'cash'`;
   - `position_qty` / `position_avg_price` / `orphan_position`: replay the account's fills
     (`GET /fills`, `fills` table) and compare with `positions`;
   - `ledger_unbalanced`: a journal that does not sum to zero — a code defect; escalate to S4 at once.
   Find the first event that diverged in the audit log (`/internal-audit/events?entityId=<account>`).
4. **Fix under change control.** A cache is re-derived from its source of truth by a reviewed script run
   by the database owner (for cash: set `accounts.cash` to the ledger sum; for positions: rebuild from
   the fills replay). Never edit fills, ledger entries or audit events (they are immutable by design).
   A code defect is fixed through a reviewed pull request; add a regression test.
5. **Verify**: `POST /reconciliation/run` → no mismatch for the account(s); chain verification
   (`/internal-audit/verify`) valid.
6. **Recover**: if the firm halted trading, the account owner (or a risk officer) requests the resume and a
   **different** risk officer or admin approves it (four-eyes; the requester cannot approve).
7. **Resolve and review** (mandatory for P1/P2): cause, how long the break existed (last clean run),
   customer impact, actions.

## Evidence for auditors

KC-20 CSV for the window (runs, mismatches, longest gap), KC-07 (four-eyes resume), KC-25 (incident
timeline), the sampled audit events, and the reconciliation run ids from the alert.

Exercised on 2026-09-26: see [tabletop](tabletop-kill-switch-reconciliation.md).
