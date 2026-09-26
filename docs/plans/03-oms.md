# Plan 03 — OMS, paper engine, pre-trade risk, kill switch (+ appropriateness, B-501, global coverage)

Lead seats: S4 (trading-systems engineer), S2 (senior trader), S8 (risk and compliance).
Inputs: master goal (including the 2026-09-26 scope amendment), goal 03, STATUS "What goal 03 needs to know"
(goals 01, 02, 05), ADRs 0000–0102, BACKLOG B-004/5/6, B-018, B-209, B-501, B-506, `design/prototype/Main.png`
(ticket, blotter, top bar).

## 1. Decisions up front

| Topic | Decision | Why |
|---|---|---|
| Where the engine runs | In the api process (`apps/api/src/trading`), single writer per account through `SELECT … FOR UPDATE` on the account row. Market data comes from the goal 02 Redis bus (last-value cache + pub/sub). | One path for manual, robot and kill-switch orders; atomic audit with the business change (ADR 0102). Scale-out later with an advisory-lock leader for the matching loop (backlog). |
| Money model | Every paper account has one **base currency** (default USD, changeable while the account has no fills). Every instrument is margin-traded (P&L-settled, CFD-style): opening a position moves no cash; realised P&L, commission, swaps and FX conversion costs are booked in base currency. | Asset-class agnostic. Honest, simple to reconcile. Real-broker cash equities come with a broker adapter (OQ-B1). |
| Quantity unit | Registry-driven through a new `asset_class_trading.multiplier_mode`: `unit` (FX, metals, crypto, equities, ETFs, funds, CFDs, indices: qty is units, price multiplier 1, `contract_size` is the lot size shown to users), `contract` (futures, options, energy, agri: multiplier = `contract_size`), `percent_of_par` (bonds: qty is face value, multiplier 0.01). | Matches the prototype (EUR/USD 100,000 units, XAU/USD 20 oz, BTC 0.8) and the registry's `min_qty`/`qty_step` grids. No asset class is special-cased in engine code. |
| FX conversion | `FxService` prices `from→to` from live SIMULATED FX quotes (direct, inverse, or triangulated through USD). Five SIMULATED pairs are added to the registry (USDHKD, USDCNY, USDINR, USDZAR, USDBRL) so every seeded quote currency converts. Conversion charges `fee_schedules.fx_conversion_bps` (placeholder) and the preview shows it. No quote or a stale quote → `FX_RATE_UNAVAILABLE`. | Global coverage without inventing a rate table; same fill-safety rules as prices. |
| Fees, margin, slippage | Registry-driven placeholders: `fee_schedules` (FK from `instruments.fee_schedule_id`), `asset_class_trading` (fat-finger band, slippage terms), `instruments.margin_rates[tier]` from goal 02. All rows `simulated = true`, listed in open questions. | Scope amendment: registry-driven, no literals in engine code. |
| Ledger | Double-entry journals (`ledger_journals` + `ledger_entries`), exact decimals (numeric without scale), append-only for `kora_app`, and a deferred constraint trigger that refuses any journal whose lines do not sum to zero. `accounts.cash` is a cache that reconciliation checks against the ledger. | Acceptance: "the ledger always balances"; reconciliation needs two independent sources. |
| Order model | One `orders` table. `type` is what the user asked for; `exec_type` is how the engine works the row (`market | limit | stop | stop_limit | trailing | none`). Brackets = entry row + `stop_loss`/`take_profit` children created on the entry's first fill, linked by `parent_order_id` and an `oco_group`. OCO = a container row (`exec_type none`) holding the `client_order_id` and two leg rows. Attached SL/TP on any order uses the same child mechanism. | Idempotency key stays on exactly one row; sibling cancellation is one query on `oco_group`. |
| States | `new → accepted → working → partially_filled → filled | cancelled | rejected | expired` (+ `new → rejected`, `accepted → working/cancelled/rejected`, working-side `expired`). Pure transition table in `@kora/domain`, exhaustive tests, every transition audited (`order.<state>`). | Goal 03 §2. |
| Idempotency | Unique `(account_id, client_order_id)`, checked under the account lock, plus `ON CONFLICT` as the last guard. Same key + same body → the original order (HTTP 200, `idempotentReplay: true`); same key + different body → 409 `client_order_id_reused`. | Acceptance: 50 parallel requests → one order. |
| Fill safety (goal 02) | Never fill when: no quote; `quote.stale`; quote older than the asset-class stale threshold; last feed `status` missing, older than 5 s, `down`, or the quote's `source` not `up`; symbol in `staleSymbols`; `sessionStatus(...)` not `open`. Market orders are **rejected** with a code; resting orders are **held** until safe. | Goal 02 STATUS "Fill safety". |
| Kill switch | `POST /kill-switch {scope, source, reason?}` keeps the goal 01 contract and adds engine results. One transaction per account: halt flag → cancel every open order (one `UPDATE … RETURNING`) → flatten each position at market through the normal fill path → `AuditService.recordMany` (one chain lock for all child events). Idempotent: repeated calls re-audit the request but do nothing else. Resume: `POST /kill-switch/resume {reason}` by trader/quant/risk_officer/admin with MFA. Robot orders (`source robot:*`) are refused while halted. | Goal 03 §6; 1,000 orders in < 2 s needs batched audit (B-006 check). |
| Robots (goal 06 interface) | Robots submit through `OmsService.submit({actor: {type:'robot', id}, …})`, the same code path as REST. REST accepts `source` `manual` or `ai-draft-accepted` only until goal 06 adds robot ownership. A `kora:ctl:robots` Redis message announces halts/resumes for the bot runner. | Same path for everyone, no spoofed robot labels. |
| LIVE | `BrokerExecutionAdapter` interface, `PaperBrokerAdapter` (ledger replay for reconciliation) and `LiveBrokerStub` that refuses unless `LIVE_TRADING_ENABLED` **and** an active `compliance_signoffs` row exist (config already refuses `true`). A DB trigger refuses `LIVE` accounts without a sign-off. | Never enabled. |
| Appropriateness (B-018) | Sign-up creates `novice` only. A generic **questionnaire engine** (`@kora/domain` grading + `QuestionnaireService`) with versioned definitions stored as reviewed JSON data files, synced to `questionnaires` at boot (an existing version whose content changes fails the boot). `GET /appropriateness/questionnaire`, `POST /appropriateness/attempts` (server-graded, pass mark and cool-down from data with env overrides, audited with version and score; answers are never stored). Pass → `trader` role; the next login forces TOTP enrolment (existing MFA rule). | Sponsor decision OQ-S2; reusable for goal 08 knowledge checks and goal 09 suitability (`kind` + weighted options). |
| Paper analytics (B-501) | `/sim/paper/*` uses the account's real fills (fee in base currency, per-symbol multiplier = registry multiplier × current FX rate to base). Accounts with no fills keep the goal 05 fixture, labelled `SIMULATED fills (fixture) · no paper fills on this account yet`, so the simulator stays demonstrable. | Documented choice. |

## 2. Files

- `packages/domain/src/trading/`: `orders.ts` (zod request schemas, types), `state-machine.ts`, `money.ts` (currency minor units), `position.ts` (net/avg/realised), `ledger.ts` (journals, balance check), `costs.ts` (commission, spread, swap, FX conversion), `slippage.ts` (depth walk + impact + volatility), `preview.ts`, `risk.ts` (rules, codes, messages), `accounts.ts` (equity, margin, leverage). `packages/domain/src/questionnaire.ts`. Tests incl. fast-check properties. Kill switch schema gains optional `reason`; `KillSwitchResumeSchema`.
- `packages/market-data/src/seed/instruments.ts` + `sim-profiles.ts`: 5 SIMULATED FX pairs.
- `apps/api/migrations/0003_trading.sql`, `0004_appropriateness.sql`.
- `apps/api/src/trading/`: `trading.module.ts`, `market-view.service.ts` (quote/depth/status/session + safety), `fx.service.ts`, `trading-registry.service.ts` (fees, asset-class params), `accounts.service.ts`, `ledger.service.ts`, `oms.service.ts` (submit/amend/cancel, idempotency, risk), `paper-engine.service.ts` (matching loop, triggers, fills, brackets/OCO, expiry, daily roll), `risk.service.ts`, `kill-switch.service.ts`, `reconciliation.service.ts`, `trading-events.service.ts` (WS publish), `broker/` (adapter interface, paper, live stub), controllers (`orders`, `accounts`, `positions`, `kill-switch`, `reconciliation`).
- `apps/api/src/appropriateness/`: data JSON, `questionnaire.service.ts`, `appropriateness.controller.ts`.
- `apps/api/src/audit/audit.service.ts`: `recordMany` (one chain lock, one multi-row insert).
- `apps/api/src/market-data/`: gateway authorises `orders|positions|account:{accountId}`; `ChannelHub` does not conflate `orders:*`.
- `apps/api/src/sim/sim.controller.ts`: real fills (B-501).
- `packages/sdk`: trading, kill switch, appropriateness methods and types; OpenAPI regenerated (B-506/B-209 partially).
- `apps/web`: sign-up without account type, `/appropriateness` page, account summary in the top bar, kill-switch results + halted banner + resume dialog, order ticket wired to preview/place (minimal; goal 04 owns the full terminal).
- Tests: domain unit/property; api unit; api integration (`orders`, `risk`, `engine`, `kill-switch`, `preview`, `appropriateness`, `reconciliation`, `ws-trading`); e2e (`appropriateness`, kill switch halted/resume, ticket preview/place).

## 3. Schema (0003, 0004)

`fee_schedules`, `asset_class_trading`, FK `instruments.fee_schedule_id → fee_schedules`, 5 FX instruments,
`accounts` (base currency, tier, halt state, settings, risk limits, cash cache, LIVE trigger),
`compliance_signoffs` (read-only for `kora_app`), `orders`, `fills`, `positions`, `ledger_journals`,
`ledger_entries` (append-only, balanced by deferred trigger), `account_equity_snapshots` (day/week start),
`alerts`, `reconciliation_runs`; `questionnaires` (append-only versions, one active per id),
`questionnaire_attempts` (append-only; score only). Every table has explicit `GRANT`s to `kora_app` and
`SELECT` to `kora_audit_reader`.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Global audit chain serialises the 1,000-order kill switch | `recordMany`: one advisory lock, hashes computed in JS, one `INSERT … SELECT unnest(...)`. Measured in the integration test. |
| Float leakage | `dec()` everywhere, numeric columns, audit rejects floats; a source scan test forbids `parseFloat`/`Number(` on money in `src/trading`. |
| Double fills under concurrent quote events | Account row lock + re-read of the order inside the transaction; per-symbol single-flight in the matching loop. |
| Tests depending on the live simulator | Integration tests write quotes/depth/status into the Redis last-value cache and bus (`test/market-fixture.ts`) and drive the engine deterministically. |
| Novice guardrails bypass | Enforced in `RiskService` from the principal's roles and view mode, never from the client. |
| Placeholder numbers mistaken for real ones | All fee, margin, slippage, swap and questionnaire data are flagged `simulated` and listed in `docs/open-questions.md`. |

## 5. Test plan (maps to acceptance criteria)

1. Idempotency: 50 parallel `POST /orders` with one `client_order_id` → one row, 1 × 201 + 49 × 200.
2. Properties (fast-check, `@kora/domain`): ledger journals always sum to zero and the trial balance is zero;
   position qty = Σ signed fills; realised + unrealised − fees = equity change (independent mark-to-market).
3. Engine: gapped stop fills worse than the stop with positive recorded slippage; bracket TP fill cancels SL;
   OCO leg fill cancels the other leg; partial fills when size exceeds top of book; IOC/FOK; trailing stop.
4. Risk: each rule positive + negative + message; novice without stop rejected.
5. Kill switch scope 3 with 1,000 open orders + positions: halted, all cancelled, flattened, < 2 s, audit shows
   each child action, chain still valid.
6. Preview fixtures: EUR/USD, XAU/USD, BTC/USD, AAPL hand-computed (domain unit test and the same numbers
   through `POST /orders/preview`), plus an FX-converted case (SAP.XETR in a USD account).
7. Fill safety: stale quote, feed status not ok, closed session → no fill.
8. Appropriateness: novice-only sign-up, questionnaire without answers, fail → cool-down, pass → trader +
   forced TOTP enrolment, audit payload (version, score, no answers); e2e through the web page.
9. Reconciliation mismatch raises a critical alert. WS `orders/positions/account` channels are private.
10. Full gate: build, lint, typecheck, test, test:integration, test:e2e.

## 6. Results (verified 2026-09-26 on the working branch)

### 6.1 Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Same `client_order_id` sent twice creates exactly one order (50 parallel requests) | **Pass** | `apps/api/test/orders.int.test.ts` "50 times in parallel": 1 × 201 + 49 × 200, one row, one `order.new` audit event; reuse with another body → 409 |
| 2 | Property tests: ledger always balances; position qty = Σ signed fills; realised + unrealised reconciles to equity change net of fees | **Pass** | `packages/domain/src/trading/ledger.property.test.ts` (fast-check, 300–400 runs each, multipliers 0.01–100,000, FX rates, flips). Found and fixed a real bug: 40-digit precision could unbalance a journal → ledger amounts quantised to 10 dp; DB trigger refuses unbalanced journals (`trading-integrity.int.test.ts`) |
| 3 | Gapped stop fills worse than the stop and reports slippage; bracket and OCO cancel siblings | **Pass** | `orders.int.test.ts`: gap 1.08000 → 1.07500 fills below the stop with `referencePrice 1.08`, slippage ≥ 0.005, `order.triggered` audited; bracket TP fill cancels SL and SL fill cancels TP; OCO leg fill cancels the other leg and fills the group; group cancel cancels legs |
| 4 | Each risk rule has a positive test, a negative test and a clear message; novice orders without a stop are rejected | **Pass** | `packages/domain/src/trading/risk.test.ts`: every one of the 23 codes has a negative case and message checks, clean positive case, at-limit edges; `apps/api/test/risk.int.test.ts` end to end (notional, fat-finger, position, leverage, margin, daily loss, rate, novice ×3, post-only, SL side, stale, feed, heartbeat, session, FX) incl. `NOVICE_STOP_REQUIRED` |
| 5 | Kill switch scope 3 halts robots, cancels all working orders and flattens all positions within 2 s under 1,000 open orders; audit shows each child action | **Pass** | `apps/api/test/kill-switch.int.test.ts` against Postgres: **178 ms** end to end (server 172 ms) for 1,000 orders + 4 positions; audit: 1 requested, 1 robots_halted, 1,000 `order.cancelled`, 4 flatten orders new/accepted/working/filled, 1 completed; chain valid; reconciliation clean |
| 6 | Preview numbers match hand-computed fixtures for EUR/USD, XAU/USD, BTC/USD and one equity | **Pass** | `packages/domain/src/trading/preview.test.ts` (arithmetic in comments) and the same numbers through `POST /orders/preview` in `apps/api/test/preview.int.test.ts` (plus SAP in EUR → USD and AAPL in a JPY account) |
| 7 | OpenAPI published, ADR 0003 written, STATUS updated | **Pass** | `packages/sdk/openapi.json` (45 paths incl. 15 new), `/docs` in dev; `docs/adr/0003-oms.md`; `docs/STATUS.md` G3 |

Additional mandatory scope:

| Scope | Result | Evidence |
|---|---|---|
| B-018 appropriateness (novice-only sign-up, questionnaire engine, API, web page, tests) | **Done** | `auth.int.test.ts`, `appropriateness.int.test.ts` (no answer key served, fail → cool-down 429, audit with version/score and no answers, pass → trader + cookie cleared + forced TOTP enrolment, version immutability, pass mark/cool-down overrides); e2e `auth.spec.ts` (full web flow and failed attempt); test helpers pass the assessment through the API |
| B-501 real paper fills | **Done** | `sim.int.test.ts`: account fills → `/analytics/paper` with base-currency fees and registry multipliers; accounts with no fills keep the labelled fixture |
| Global coverage (registry-driven, base currency, FX) | **Done** | multiplier modes, fee schedules and execution params are registry rows; SAP (EUR) in USD and AAPL (USD) in JPY previews; `FX_RATE_UNAVAILABLE` blocks when no fresh rate |
| Kill switch wired to web, halted banner, resume; top-bar account figures | **Done** | e2e `trading.spec.ts`, `kill-switch.spec.ts`, `a11y.spec.ts` (axe on the halted banner and the assessment page) |
| Fill safety from goal 02 | **Done** | `risk.int.test.ts` fill-safety tests; resting orders held then filled when safe; kill-switch flatten held when the feed is down |
| LIVE stub, never enabled | **Done** | `trading-integrity.int.test.ts`, `trading.unit.test.ts` |

### 6.2 Gate run

| Command | Result |
|---|---|
| `pnpm build` | 7/7 tasks successful |
| `pnpm lint` | 12/12 tasks, 0 warnings |
| `pnpm typecheck` | 12/12 tasks |
| `pnpm test` | domain 102, api 37, sdk 11, web 15, market-data 60, ui 113, bot-runner 5 — all pass; coverage thresholds met (domain `src/trading` 98.6 % lines) |
| `pnpm test:integration` | 17 files, 118 tests pass (was 10 files / 70 tests) |
| `pnpm test:e2e` | 26 tests pass (was 21) |
| `pnpm py:check` | 85 passed, 98.9 % coverage (quant unchanged) |

Measured:

```
[kill-switch] scope 3 with 1,000 open orders + 4 positions: 178 ms end-to-end (server 172 ms)
[risk timing ms] rules p50 0.064 p95 0.141 max 0.224; with context load p50 3.609 p95 4.911
```

### 6.3 Deferred (with reason)

| Item | Reason | Backlog |
|---|---|---|
| Robot runner consuming `kora:ctl:robots` and submitting through the OMS | Goal 06 builds the robots; the interface (`OmsService.submit` with `actor.type='robot'`, `source='robot:{id}'`, halt refusal `TRADING_HALTED`) is implemented and tested | B-301 |
| Matching-loop scale-out across api replicas | Single writer is enough for goal 03 volumes | B-302 |
| Queue-position / trade-print matching, triple-swap days, margin close-out | Paper realism beyond the goal; placeholders need Sponsor values (OQ-B3) | B-304, B-307 |
| Full Pro ticket and streaming blotter; Novice trade flow | Goals 04 and 08 (minimal wiring shipped so the engine is usable end to end) | B-305, B-306 |
| SDK generation from OpenAPI, response schemas | Still hand-written types mirrored by the spec | B-004, B-209, B-312 |
