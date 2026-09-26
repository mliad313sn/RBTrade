# Runbooks and operational resilience

Goal 09. Owner: Operations / SRE (S10) with Risk & Compliance (S8). Everything here describes the
PAPER platform with SIMULATED data. Nothing in these documents is legal or regulatory advice; figures
marked *proposed* are operating targets for the Sponsor to confirm (OQ-O1).

| Document | Use it when |
|---|---|
| [Service level objectives](slos.md) | Setting alerts, judging impact and priority |
| [Incident workflow (ITIL 4)](incident-workflow.md) | Anything goes wrong: detect → log → classify → resolve → review |
| [Post-incident review template](post-incident-review-template.md) | Closing any P1/P2 (mandatory) and useful for P3 |
| [Feed outage](feed-outage.md) | Prices stop, go stale or the feed status is `down` |
| [Engine stall](engine-stall.md) | Orders stop filling or changing state while prices move |
| [Reconciliation break](reconciliation-break.md) | A `reconciliation.mismatch` critical alert |
| [AI provider outage](ai-provider-outage.md) | The copilot says "Copilot unavailable", news scoring fails |
| [Kill switch fired](kill-switch-fired.md) | Any kill switch (account or firm-wide) |
| [Database restore](database-restore.md) | Data loss or corruption; restore tests |
| [Tabletop: kill switch fired + reconciliation break](tabletop-kill-switch-reconciliation.md) | Exercise record with evidence (2026-09-26) |

## Where things are

- **Risk console** (`/risk`, risk officer/admin): live alerts (`risk:alerts` WebSocket channel, REST
  fallback every 5 s), exposure vs limits, four-eyes approvals, firm-wide kill switch, reconciliation,
  incidents, evidence export.
- **Internal audit view** (`/internal-audit`, auditor/risk officer/admin): chain + anchor verification,
  sampling, exports.
- **Health:** `GET /health` (db, redis, IdP), `GET /market-data/status`, WS `status` channel, bot runner
  `GET /health` (robot counts, heartbeats), `GET /metrics` (Prometheus, `KORA_METRICS_TOKEN`).
- **Incident register:** `/governance/incidents` (API), shown on the console; control KC-25.
- **Evidence:** `GET /governance/controls/{id}/evidence?from&to&format=csv|pdf` (see the control matrix).

## Roles in an incident

| ITIL 4 role | KORA holder |
|---|---|
| Incident manager | On-call SRE (S10) for P3/P4; the risk officer on duty leads P1/P2 that touch trading |
| Technical responder | Engineering on call (S3/S4; S7 for AI; S9 for security) |
| Risk and compliance | Risk officer (2nd line): kill switch, four-eyes approvals, customer impact |
| Communications | Product Owner for customer-facing notices (no trading nudges, plain words) |
| Independent review | Internal audit (3rd line) samples closed incidents quarterly (KC-31) |
