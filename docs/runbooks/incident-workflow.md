# Incident workflow (aligned with ITIL 4 incident management)

Owner: Operations / SRE (S10); Risk & Compliance (S8) for trading incidents. Control: KC-25 (COBIT
2019 DSS02, DSS03). Every step below is recorded in the incident register (`incidents` table, API
`/governance/incidents`, shown on the risk console) and in the audit log (`incident.*` events).

```
detect ──► log ──► classify ──► investigate & resolve ──► close with post-incident review
  │          │          │                  │                         │
alerts,   POST       impact ×          runbook steps,            P1/P2: review_ref required
probes,  /governance urgency →         containment first         (template), actions tracked
reports   /incidents  P1..P4            (kill switch),           in BACKLOG
```

## 1. Detect

Sources, in order of trust:

1. **Automated alerts** in the `alerts` table, live on the risk console (`risk:alerts`, ≤ 5 s):
   `reconciliation.mismatch` (critical), `kill_switch.fired`, `risk.limit_breach`, `robot.*`
   auto-pauses (heartbeat lost, loss/drawdown limits).
2. **Health and status:** `/health` 503, feed `status` = `degraded`/`down`, bot runner heartbeat gaps.
3. **Control evidence exceptions** (e.g. KC-12 chain invalid, KC-20 long gap between runs).
4. **People:** customer contact, desk observation, internal audit finding.

## 2. Log

Log as soon as something is not normal; a false alarm is closed cheaply, a missing record is a finding.

`POST /governance/incidents {title, description, category, detectedAt?, alertId?, exercise?}`
(risk officer or admin). Categories: `feed_outage`, `engine_stall`, `reconciliation_break`,
`ai_provider_outage`, `kill_switch_fired`, `database_restore`, `security`, `other`. From an alert on
the console, pass `alertId` so the link is kept. `detectedAt` is when the problem was first seen, not
when it was logged.

## 3. Classify

`POST /governance/incidents/{id}/classify {impact, urgency}` sets the priority (impact × urgency):

| Impact \ Urgency | high | medium | low |
|---|---|---|---|
| **high** (book integrity, orders wrong, many customers, security) | P1 | P2 | P3 |
| **medium** (one service degraded, workaround exists) | P2 | P3 | P3 |
| **low** (cosmetic, single user, no money effect) | P3 | P3 | P4 |

| Priority | Response | Who leads | Updates |
|---|---|---|---|
| P1 | immediately, 24/7 | risk officer on duty + SRE on call | every 30 min |
| P2 | within 30 min | SRE on call (risk officer informed) | every hour |
| P3 | same business day | owning team | daily |
| P4 | planned | owning team | on change |

Re-classify (`resolved → classified` is allowed) if the picture changes.

## 4. Investigate and resolve

1. **Contain first.** If trading could make it worse, use the kill switch: the customer's own, or the
   **firm-wide kill switch** on the console (hold 1.5 s; scope 1 halts robots, 2 also cancels, 3 also
   flattens). A firm halt can only be lifted by **two people** (four-eyes, control KC-07).
2. Follow the category's runbook. Record each significant action in the incident description or the
   ticket system; the audit log already records every API action.
3. Fix under change control: code and schema changes through reviewed pull requests and migrations
   (KC-10); a data correction is a documented, reviewed script run by the database owner.
4. Verify with the runbook's check (e.g. a clean reconciliation run, feed `ok`, chain valid).
5. `POST /governance/incidents/{id}/resolve {resolution}`.

## 5. Close with a post-incident review

- `POST /governance/incidents/{id}/close {reviewRef}`. **P1 and P2 cannot close without a review
  reference** (API 400, database constraint). Use the [template](post-incident-review-template.md);
  store the review in `docs/incidents/` (or the ticket system) and reference it.
- Actions from the review go to `docs/BACKLOG.md` with an owner and a target goal.
- Internal audit samples closed incidents each quarter (`/internal-audit/sample?controlId=KC-25`).

## Communication

- Internal: the incident channel; the risk console shows open incidents to the 2nd line.
- Customers: plain words, what happened, what we did, what they need to do (usually nothing). No
  urgency cues, no nudges to trade. Novice copy follows the goal 08 readability rules.
- Regulators/partners: only through the Sponsor and Compliance; notification duties and deadlines
  are jurisdiction-specific and not set yet (OQ-R2, OQ-O2).
