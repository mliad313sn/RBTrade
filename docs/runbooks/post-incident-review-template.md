# Post-incident review — INC-XXXXXX

> Template (goal 09, ITIL 4). Blameless: describe systems and decisions, not people. Required to close
> P1/P2 incidents (`reviewRef`); recommended for P3. Copy to `docs/incidents/INC-XXXXXX.md`.

| Field | Value |
|---|---|
| Incident | INC-XXXXXX (`/governance/incidents/{id}`) |
| Title | |
| Category | feed_outage / engine_stall / reconciliation_break / ai_provider_outage / kill_switch_fired / database_restore / security / other |
| Priority | P1 / P2 / P3 / P4 (impact × urgency) |
| Detected | YYYY-MM-DD HH:MM UTC (source: alert id / probe / person) |
| Logged / classified / resolved / closed | timestamps from the register |
| Time to detect / to resolve | minutes |
| Incident manager | |
| Reviewers | at least one person who was not a responder; 2nd line for trading incidents |
| Exercise? | yes / no |

## 1. Summary

Two or three sentences a customer could understand: what happened, who was affected, how long.

## 2. Impact

- Customers / accounts affected (count, PAPER only today):
- Orders, fills, positions or cash affected (ids or counts):
- SLOs breached (see `docs/runbooks/slos.md`) and error budget used:
- Controls that fired or failed (control matrix ids):

## 3. Timeline (UTC)

| Time | Event | Source (alert id, audit event id, log) |
|---|---|---|
| | First signal | |
| | Incident logged | |
| | Containment (e.g. kill switch id) | |
| | Cause identified | |
| | Fix applied (change / PR / script) | |
| | Verified (check and result) | |
| | Resume / recovery (four-eyes request id if a firm halt) | |

## 4. Cause

- Direct cause:
- Contributing factors (5 whys, systems thinking):
- Why detection took as long as it did:

## 5. What went well / what did not

## 6. Evidence

Attach or link: evidence exports (`/governance/controls/{id}/evidence`, with SHA-256), the audit
sample, chain verification result, relevant logs. Evidence must be reproducible by internal audit.

## 7. Actions

| # | Action | Owner | Target (goal / date) | Backlog id |
|---|---|---|---|---|
| 1 | | | | B-9xx |

## 8. Sign-off

| Role | Name | Date |
|---|---|---|
| Incident manager | | |
| Risk & Compliance (2nd line) | | |
