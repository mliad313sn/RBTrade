# Service level objectives (proposed)

Owner: Operations / SRE (S10). Status: **proposed operating targets**, not regulatory values; the
Sponsor confirms them before launch (OQ-O1). Measured on the PAPER platform; LIVE targets need the
broker's own SLAs (OQ-B1). Error budgets are per rolling 30 days.

| # | Service level indicator | Objective (proposed) | Measured by | Runbook |
|---|---|---|---|---|
| SLO-1 | API availability: share of `GET /health` probes answering 200 | 99.9 % per 30 days | external probe every 30 s (goal 10 monitoring, B-012) | [database restore](database-restore.md), [engine stall](engine-stall.md) |
| SLO-2 | Order acknowledgement: `POST /orders` to 201/422, p99 | < 250 ms | api traces (OpenTelemetry) | [engine stall](engine-stall.md) |
| SLO-3 | Kill switch completion (`kill_switch.completed.durationMs`), max | < 2,000 ms (goal 03 acceptance) | audit events (control KC-17 evidence) | [kill switch fired](kill-switch-fired.md) |
| SLO-4 | Market data freshness: share of time the feed status is `ok` during venue sessions | 99.5 % | `status` channel / `GET /market-data/status` | [feed outage](feed-outage.md) |
| SLO-5 | Tick-to-screen latency p95 (terminal) | < 100 ms (goal 04 measured 42 ms) | web performance mark | [feed outage](feed-outage.md) |
| SLO-6 | Reconciliation cadence: longest gap between scheduled runs | < 5 minutes (runs every 60 s) | `reconciliation_runs` (control KC-20 evidence) | [reconciliation break](reconciliation-break.md) |
| SLO-7 | Risk alert delivery to the console (insert → WS frame), p99 | < 5 s (goal 09 acceptance; tests measure ~60 ms) | integration test + e2e; relay counters on `GET /risk-console/alerts` | [kill switch fired](kill-switch-fired.md) |
| SLO-8 | Critical alert acknowledged by the 2nd line | within 1 business hour | `alerts.acknowledged_at` (control KC-19 evidence) | [incident workflow](incident-workflow.md) |
| SLO-9 | Copilot availability when configured (answers not "unavailable") | 99 % | `ai.request` status, `kora_ai_requests_total` | [AI provider outage](ai-provider-outage.md) |
| SLO-10 | Backup recovery point objective (RPO) | ≤ 24 h (daily dump; PITR in production reduces it) | `backup_runs` (control KC-26 evidence) | [database restore](database-restore.md) |
| SLO-11 | Restore recovery time objective (RTO) | ≤ 4 h to a verified restore | restore tests in `backup_runs` | [database restore](database-restore.md) |
| SLO-12 | Audit chain verification | valid = true every day; an anchor every day | `/internal-audit/verify`, `audit_anchors` (KC-12, KC-13) | [database restore](database-restore.md) |

## Using the error budget

- Budget left > 50 %: normal change cadence.
- Budget left 0–50 %: changes that touch the order path, the feed or the kill switch need a second
  reviewer from S4/S10 and a rollback plan.
- Budget exhausted: feature changes stop until the post-incident actions that restore the SLO are done.

## Priority mapping

A breach of SLO-3, SLO-6 or SLO-12, or any doubt about book integrity, is at least **P2**; with
customer money at risk (LIVE, not enabled) it would be **P1**. See the matrix in the
[incident workflow](incident-workflow.md).
