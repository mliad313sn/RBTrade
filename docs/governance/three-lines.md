# Three lines of defence in KORA

Goal 09. How the Three Lines model maps to roles, tooling and controls. Owner: S8.

| Line | Who (role) | Owns | Tooling | Cannot |
|---|---|---|---|---|
| **1st line** — run the business and its controls | `trader`, `quant`, `novice` (customers); engineering and operations (`admin`) | trading decisions, strategies and robots, platform operation, automated preventive controls (pre-trade limits, guardrails, kill switch, reconciliation) | terminal, robots, novice view; `/health`, runbooks, incident register | approve their own four-eyes requests; loosen limits above the platform default alone; lift a firm halt alone |
| **2nd line** — oversee risk and compliance | `risk_officer` | risk appetite in limits, four-eyes approvals, firm-wide kill switch, alerts, disclosures and their publication, suitability profiles, best execution | **risk console** `/risk` (live alerts, exposure vs limits, approvals, kill-switch history, reconciliation, AI rates, novice guardrail events, incidents, evidence export), `/compliance/*` | sign off their own robot; approve a request about their own account or their own draft |
| **3rd line** — independent assurance | `auditor` (new in goal 09) | testing that controls work, independently | **internal audit view** `/internal-audit` (read-only audit log, chain + anchor verification, seeded sampling, CSV exports), evidence export for every control | hold any operating role (SoD enforced by the admin API and a database trigger); trade-control, approve, publish or change anything |

## Segregation of duties enforced in code

| Rule | Where |
|---|---|
| Auditor ≠ trader / quant / risk officer / admin | `rolesConflict()` in the admin API; `user_roles_sod` trigger |
| Approver ≠ requester (all four-eyes kinds) | `FourEyesStore.lockPending` (403 `four_eyes`); `four_eyes_guard` trigger and `four_eyes_distinct_approver` check |
| Approver ≠ person the request is about (account holder, MFA subject, drafter) | `FourEyesService.assertIndependent`; `disclosure_documents_four_eyes` check |
| Robot owner ≠ risk signer | goal 06 `robot_signoff_four_eyes` trigger |
| Firm halt → two people to resume | `KillSwitchService.resumeNeedsFourEyes` (`KORA_FOUR_EYES_RESUME`) |

## Control coverage by line

See `docs/governance/control-matrix.md` (owner line per control): 1st line operates KC-01…03, 09–11,
14–18, 20, 22, 25, 26; 2nd line owns KC-04…08, 12, 19, 21, 23, 24, 27…30; 3rd line owns KC-13 and KC-31
and tests every control through evidence exports and sampling.
