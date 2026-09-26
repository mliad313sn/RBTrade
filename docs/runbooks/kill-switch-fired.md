# Runbook — kill switch fired

Category `kill_switch_fired`. SLO-3 (≤ 2 s), SLO-7 (alert ≤ 5 s). Controls: KC-17 (kill switch
available and fast), KC-07 (four-eyes resume after a firm halt), KC-19. Owner: risk officer on duty.

## What happens when it fires

| Scope | Effect (goal 03 engine, one transaction per account) |
|---|---|
| 1 `robots` | halt flag set; robot orders refused (`TRADING_HALTED`); runners stop (`kora:ctl:robots`) |
| 2 `robots_cancel` | + every working order cancelled |
| 3 `robots_cancel_flatten` | + every position closed at market (held, reported `flattenPending`, if the market is not safe) |

Every child action is audited (`kill_switch.requested`, `order.cancelled`, flatten orders,
`kill_switch.completed` with `durationMs`) and a `kill_switch.fired` alert reaches the risk console
(**critical** when fired by the firm, warning when fired by the account holder).

- **Account kill switch:** the account holder (top bar, Ctrl+Shift+K, 1.5 s hold, REST fallback).
- **Firm-wide kill switch (B-314):** risk officer or admin on the console (1.5 s hold, reason required),
  `POST /risk-console/kill-switch`. It runs on every active account and marks each halt as a **firm
  halt** (`halted_by` = the risk officer).

## Steps for the 2nd line

1. **Acknowledge** the alert. Who fired it, which scope, why (`reason`)? Kill-switch history on the
   console; audit events filtered by `kill_switch.*`.
2. **Log an incident** for any firm-wide activation or any activation with `flattenPending` > 0; an
   account holder's own scope-1 halt with a clear reason can be noted without an incident.
3. **Check the outcome:** `ordersCancelled`, `positionsFlattened`, `flattenPending` (held flatten orders
   keep working and fill when the market is safe; watch them), `durationMs` ≤ 2,000 (SLO-3).
4. **Find and fix the cause** (runaway robot, bad data, reconciliation break, security event) with the
   matching runbook. Robots stay halted until trading resumes; restarting a robot is a separate owner
   action.
5. **Resume:**
   - self-imposed halt: the account holder resumes with a written reason (audited);
   - **firm halt:** the holder (or a risk officer) requests the resume → `202` with a pending four-eyes
     request → a **different** risk officer or admin approves on the console (the requester and the
     account holder cannot approve; enforced by the API and a database trigger). The approval runs the
     resume and records both names. Policy `KORA_FOUR_EYES_RESUME=all` makes every resume four-eyes
     (intended for LIVE).
6. **Verify:** `GET /kill-switch` → not halted; `POST /reconciliation/run` clean; robots resumed only by
   their owners.
7. **Resolve and review.** Evidence: KC-17 (timings), KC-07 (four-eyes), KC-25.

Exercised on 2026-09-26: see [tabletop](tabletop-kill-switch-reconciliation.md).
