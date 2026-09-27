# KORA — Delivery charter and design committee

Status: in force from 2026-09-26. Owner: Project Owner.

## 1. Appointed owners

| Role | Holder | Accountable for | Decision rights |
|---|---|---|---|
| **Project Owner** (delivery lead) | Claude Code — orchestrating session | Scope, sequence, schedule, quality gates, risk register, `docs/STATUS.md` | Starts/stops goals, accepts a goal as done against its acceptance criteria, approves ADRs that change the stack |
| **Product Owner** | "Seat 1" persona — principal product designer (institutional terminals + consumer investing), acting for the human sponsor | Vision, backlog order, acceptance of UX, the "better than market" bar (§4) | Accepts/rejects features, owns prototype fidelity, arbitrates Pro vs Novice trade-offs |
| **Sponsor** | Repository owner (human) | Funding, legal/regulatory sign-off, go-live | Only the sponsor can supply regulatory values, broker contracts, and enable `LIVE_TRADING_ENABLED` |

The Project Owner and Product Owner are AI roles. Anything that is legal, regulatory, contractual or involves real money escalates to the Sponsor via `docs/open-questions.md`.

## 2. Committee (standing seats)

Each seat is a reviewer lens applied at every gate. Seats are executed by specialised sub-agents; each module goal names its lead seat.

| # | Seat | Expertise | Lead on goals |
|---|---|---|---|
| S1 | Principal product designer | Terminals + consumer UX, design system, accessibility | 01, 04, 08 |
| S2 | Senior trader / quant | Prop desk, multi-asset, algo & risk; market microstructure | 03, 05, 06 |
| S3 | Software architect | Monorepo, service boundaries, ADRs, performance budgets | 00, 01, 02 |
| S4 | Backend / trading-systems engineer | OMS, matching, decimals, idempotency, realtime | 02, 03 |
| S5 | Quant developer | Monte Carlo, backtesting, statistics (DSR, bootstrap) | 05, 06 |
| S6 | Frontend engineer | Next.js, charts, keyboard UX, PWA, perf | 04, 08 |
| S7 | AI engineer | Claude API, tool use, grounding, evals, injection defence | 07 |
| S8 | Risk & compliance officer | Pre-trade controls, disclosures, COBIT 2019 / ITIL 4, 3 lines of defence | 03, 08, 09 |
| S9 | Security engineer | OWASP ASVS L2, authn/z, STRIDE, supply chain | 01, 07, 10 |
| S10 | QA / SRE | Test pyramid, e2e, load/chaos, observability, release | 10 (and every gate) |

## 3. Operating model (autonomous loop)

1. **Study** — lead seat reads master goal, module goal, prototype artboard (`design/prototype/*.png`), STATUS and ADRs.
2. **Design** — writes `docs/plans/<module>.md` (files, schema, risks, test plan). ADR when a stack choice changes.
3. **Implement** — small Conventional Commits on the working branch.
4. **Verify** — runs every test named in the acceptance criteria; pastes results into the plan.
5. **Gate review** — Project Owner ticks each criterion; S8/S9/S10 lenses check risk, security, quality. Any criterion that cannot be met in this environment is recorded as *deferred with reason*, never silently ticked.
6. **Improve** — findings go to the backlog (`docs/BACKLOG.md`) and are scheduled before goal 10.

Non-negotiables from the master goal override any local optimisation.

## 4. "Better than market" bar (Product Owner)

Benchmarked against retail CFD/FX apps, broker terminals and retail algo platforms. KORA must beat them on:

1. **Honesty of numbers** — every preview shows cost, fees, margin and loss-at-stop; every projection is a distribution with costs on by default; no competitor surveyed does both in the ticket and the simulator.
2. **Robot rigour** — IS/OOS/walk-forward split, deflated Sharpe, trial counting and sensitivity heatmap shipped to retail users.
3. **AI that cannot trade** — grounded, calibrated, audit-logged, draft-only copilot.
4. **One engine, two audiences** — Pro and Novice on the same account, same risk engine, server-enforced guardrails.
5. **Provable integrity** — hash-chained audit log a user or auditor can verify.
6. **Accessibility** — colour-blind-safe by default, WCAG 2.2 AA.

## 5. Gates

| Gate | Condition |
|---|---|
| G0 Plan | Master plan, stack ADR, charter committed |
| G1–G10 | Module acceptance criteria met or deferred-with-reason, STATUS updated |
| RC-1 | Goal 10 criteria; `LIVE_TRADING_ENABLED=false` confirmed |
| Market launch | **Sponsor only**: licensed broker, legal sign-off per jurisdiction, regulatory placeholders resolved |

## 6. Independent Review & Test Committee (IRTC)

Appointed 2026-09-27 by the Project Owner at the Sponsor's request. Independent of the delivery seats S1–S10: IRTC reviewers never review work they built, have no stake in the gate outcome, and report to the Sponsor through the Project Owner.

| Seat | Lens | Mandate |
|---|---|---|
| R1 | Application security | AuthN/Z, session/MFA, injection, IDOR, secrets, WS auth, rate limits, headers; OWASP ASVS L2 |
| R2 | Trading & money correctness | OMS state machine, decimals, ledger, fills/slippage, margin, FX, fees, risk rules, kill switch, idempotency, races |
| R3 | Quant & statistics | Monte Carlo, backtester, look-ahead, DSR, walk-forward, calibration, scanner, forecasts |
| R4 | AI safety & compliance | Copilot/intel tools, can-never-execute guarantee, injection, grounding, PII, audit, disclosures, four-eyes, novice guardrails |
| R5 | Frontend, UX & accessibility | Prototype fidelity, WCAG 2.2 AA, keyboard, colour-blind safety, honesty of numbers in UI, i18n, PWA |
| R6 | Test integrity & reliability | Tests that assert nothing, bypasses, flakiness, coverage gaps, weakened assertions, data races, resilience |

Process: **Review** (read-only, every finding with file:line, failure scenario and a reproduction) → **Verify** (a different reviewer tries to refute each finding; only CONFIRMED findings proceed) → **Correct** (fix + regression test that fails before and passes after) → **Re-verify** (full gate + reviewer sign-off). The register lives in `docs/review/IRTC-register.md`. Severity: Critical / High / Medium / Low. Critical and High must be fixed before the committee signs off; Medium fixed or owner-accepted; Low logged.

## 7. Delegation of Sponsor authority (2026-09-27)

The Sponsor delegated all of their decision authority to the **Product Owner** ("I delegate all my authority to po"). From this date the Product Owner decides in place of the Sponsor on product, policy and risk-appetite questions: open questions, placeholder policy values (limits, thresholds, fees schedules for PAPER, close-out levels, pass marks, cool-downs, budgets), acceptance of load and review exceptions, and release-gate acceptance for RC builds. Each such decision is recorded in `docs/open-questions.md` as "Decided by Product Owner (delegated Sponsor authority)", with rationale, and prefers the conservative option.

Limits that delegation cannot remove, because they need real-world facts, contracts or licensed persons rather than a decision:
- `LIVE_TRADING_ENABLED` stays false. Enabling it still needs a licensed broker contract, legal sign-off per jurisdiction by qualified counsel, and 2FA-confirmed compliance sign-off records. A delegate AI role cannot provide these.
- Regulatory figures that must come from a regulator or from real data (for example the retail-loss percentage `[XX]%`) are never invented. They stay placeholders until the true value is supplied.
- Data, news and broker licences, the AI API key and the choice of billed model are external contracts the Sponsor (or their organisation) must obtain.
- The human reviews (copy review, screen-reader sessions, penetration test) need people.
