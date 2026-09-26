# Runbook — paper engine stall

Category `engine_stall`. SLOs: SLO-1, SLO-2. Controls: KC-17, KC-20. Owner: SRE on call; S4 (trading
engine).

## Symptoms and signals

- Marketable orders stay `working` while quotes are fresh and the session is open; stops/limits do not
  trigger; no new `order.filled` / `order.partially_filled` audit events although prices move.
- The matching loop (`EngineLoopService`: Redis quote events + a sweep every `KORA_ENGINE_SWEEP_MS`)
  logs errors or stops logging sweeps.
- `POST /orders` latency climbs (SLO-2) or requests time out (database lock contention on the account
  row, pool exhaustion).
- Robots report decisions but no fills; the bot runner is healthy (`GET /health` on the runner).

## Triage

1. Confirm the market is safe: feed `ok`, session `open` (otherwise it is by design, see
   [feed outage](feed-outage.md)).
2. `GET /health`: database and Redis up? Long-running queries (`pg_stat_activity`) or lock waits?
3. One account or all? One account stuck usually means a long transaction holding its lock.
4. Log the incident: P2 (orders not executing); P1 if orders execute wrongly.

## Contain

- **Stop new risk:** firm-wide kill switch scope 1 or 2 from the risk console if robots keep sending
  orders into a stalled engine. Scope 3 (flatten) would itself need the engine: use it only once the
  engine works again, or accept that flatten orders stay held (they are reported as `flattenPending`).
- Keep customers informed: orders are accepted but not filled; nothing is lost.

## Diagnose and recover

1. Look for the first error after the last good sweep in the api logs (`EngineLoop`, `PaperEngine`).
2. Stuck transaction: identify it in `pg_stat_activity`; cancel it with `pg_cancel_backend` (owner/DBA)
   and record the query and pid in the incident.
3. Restart the api process (the engine is in-process; one active matcher per deployment until B-302).
   On restart the sweep re-evaluates every working order; nothing depends on in-memory state except
   caches.
4. If a code defect: roll back to the previous release (release record KC-11 shows the build) and fix
   forward through a reviewed pull request.

## Verify

- A test order on BTC/USD (24/7 in the SIMULATED feed) fills; held orders fill or re-rest on the next
  sweep; `POST /reconciliation/run` returns no mismatches; kill switch history shows no pending
  flattens.
- If trading was halted by the firm, resume through four-eyes (request + a second approver).

## Close

Resolve, then review (P1/P2). Evidence: KC-17 (kill switch timings), KC-20, the order audit trail for
the window (`/internal-audit/events?action=order.*&from&to`).
