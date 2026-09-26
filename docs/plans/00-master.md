# Plan 00 — KORA master plan

Owner: Project Owner. Lead seat: S3 (architect), with S1 (design) and S9 (security).
Status: G0 (plan) — this document, the stack ADR and the charter are committed.

## 1. What we are building

KORA is one platform with four modules (Pro Terminal, Gain Simulator, Robot Trader, Novice view). All four share one account, one instrument registry, one risk engine and one hash-chained audit trail. The platform runs **PAPER only**. `LIVE_TRADING_ENABLED=false` is hard-wired as the default and only the Sponsor can change it (charter §1).

The visual reference is `design/prototype/*.png`:

| Artboard | Used by goal | Notes |
|---|---|---|
| `Committee.png` | 01 (tokens), all | Pro dark palette, novice light palette, typography, "mistakes we refuse to ship" |
| `Main.png` | 01 (shell), 02, 03, 04 | Pro shell: top bar, left rail, status bar, watchlist, chart, book, ticket, blotter, copilot strip |
| `Novice.png` | 01 (shell), 08 | Novice shell: top tabs, "Practice money" chip, Simple/Pro toggle, risk banner with `[XX]%` placeholder |
| `Simulator.png` | 05 | Monte Carlo fan chart, stress toggle, reality checks |
| `Robots.png` | 06, 07 | Block builder, IS/OOS/WF KPIs, heatmap, copilot drawer |

The `.dc.html` sources named in the goal prompts were not exported, so the PNGs are the reference (see `docs/open-questions.md` OQ-D1).

## 2. Architecture (confirmed in ADR 0001)

```
apps/web             Next.js App Router, TS strict, Tailwind v4 over CSS-variable tokens
apps/api             NestJS REST (+ WS gateway from goal 02), zod DTOs, OpenAPI at /docs
services/quant       Python FastAPI (3.11 and 3.12 compatible)
services/bot-runner  TypeScript BullMQ worker
packages/ui          Design system: tokens, primitives, formatters, Storybook
packages/domain      Shared types and decimal maths (decimal.js)
packages/sdk         Typed API client (hand-written stub now, generated from OpenAPI later)
infra/               docker-compose deployment reference, Keycloak realm, OTel, Prometheus, Grafana
scripts/             dev-db.sh (native Postgres + Redis), db bootstrap, contrast check helpers
docs/                goals, plans, ADRs, STATUS, BACKLOG, open questions
```

Cross-cutting contracts that every goal must honour:

1. **Money is decimal.** Domain type `Decimal` from `packages/domain`, which re-exports decimal.js. Postgres uses `numeric`. JSON carries decimals as **strings**. The audit canonicaliser rejects non-integer JSON numbers, so a float cannot slip into the hash chain.
2. **Audit first.** Every state change calls `AuditService.record()` (`apps/api/src/audit`). One chain per database. Writes are serialised by an advisory lock.
3. **Identity.** API guards read one `Principal` (`sub`, `roles`, `mfa`). It is produced by either the built-in dev OIDC provider or Keycloak (ADR 0101). `@Roles()` and `@RequireMfa()` are the only authorisation primitives.
4. **Two themes, one set of tokens.** `packages/ui/src/tokens.ts` is the single source of truth. It generates `tokens.css`, and the contrast check reads it.
5. **Paper first.** `LIVE_TRADING_ENABLED` is parsed by `apps/api/src/config` and forced to `false` unless `KORA_ENV=live` **and** a compliance record exists (goal 09). In goal 01 it is always false.

## 3. Sequencing and gates

| Gate | Goal | Lead seats | Depends on | Exit evidence |
|---|---|---|---|---|
| G0 | 00 plan | S3, S1, S9 | — | this plan, ADR 0000/0001, STATUS |
| G1 | 01 foundation | S3, S1, S9 | G0 | `docs/plans/01-foundation.md` results |
| G2 | 02 market data | S3, S4 | G1 | ADR 0002, snapshot + load results |
| G3 | 03 OMS + paper + risk + kill switch | S4, S2, S8 | G1, G2 | ADR 0003, property tests, kill switch in < 2 s |
| G4 | 04 Pro terminal UI | S1, S6 | G2, G3 | e2e, visual regression |
| G5 | 05 Gain simulator | S5, S2 | G1 (G3) | statistical tests, benchmark |
| G6 | 06 Robot trader | S2, S5 | G2, G3, G5 | parity test, DSR reference values |
| G7 | 07 AI copilot | S7, S9 | G3, G4, G6 | ADR 0007, injection suite |
| G8 | 08 Novice view | S1, S6, S8 | G3, G4, G5 | API-level guardrail tests, Lighthouse |
| G9 | 09 Governance | S8 | all | control matrix, four-eyes tests |
| G10 | 10 QA / RC-1 | S10, S9 | all | all CI stages green, threat model |

Goals 05 and 08 may run in parallel worktrees after G3.

## 4. Environment strategy (ADR 0000)

- Dev and test use **native** PostgreSQL 16 and Redis 7 through `scripts/dev-db.sh`, because there is no Docker daemon in the cloud sessions. `pnpm dev` works without Docker.
- `infra/docker-compose.yml` is the deployment and reference topology. It is never required to run tests.
- CI (GitHub Actions) uses service containers for Postgres and Redis. The schema, roles and migrations are identical.
- TimescaleDB is optional. Migrations must run on plain Postgres. Goal 02 creates hypertables only when the extension exists.

## 5. Risk register (top items)

| # | Risk | Impact | Mitigation | Owner |
|---|---|---|---|---|
| R1 | Keycloak not runnable in the build environment | Auth untested against the real IdP | OIDC-compatible dev IdP in the api, same JWT claim shape as Keycloak; realm export kept; KC e2e in CI later (BACKLOG B-001) | S9 |
| R2 | Floats creeping into money paths | Wrong P&L, audit mismatch | decimal.js everywhere; lint rule bans `parseFloat` in domain/ui; audit canonicaliser rejects floats | S4 |
| R3 | Hash chain races under concurrent writes | Broken chain | Transaction-level advisory lock; concurrency test | S3 |
| R4 | Pro/Novice drift into two products | Inconsistent risk | Same API, same engine; view mode is a preference only; guardrails server-side (goal 08) | S1, S8 |
| R5 | Regulatory values invented | Legal exposure | `[XX]%` placeholders plus `docs/open-questions.md` | S8 |
| R6 | Toolchain majors moving fast | Build breakage | Pinned known-stable majors (ADR 0001); upgrade in BACKLOG | S3 |
| R7 | No Docker, so no image scan locally | Supply-chain gap | Trivy runs in CI; `pnpm audit` and `pip-audit` locally | S9 |

## 6. Definition of done per goal

The global DoD from the master goal applies. In addition, per goal:
- plan file with a pasted verification log;
- any criterion that cannot be met here is marked **deferred with reason** and gets a BACKLOG entry;
- STATUS updated, Conventional Commits, no push.
