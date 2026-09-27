# IRTC R2 — Trading & money corrections

Corrector for the IRTC seat R2 report (trading and money correctness, reviewed 2026-09-27 on `claude/magical-newton-yyxga6`). Process per charter §6: reproduce and confirm each finding, write a regression test that fails on the reviewed code, fix the root cause, show that the test passes.

Policy values that needed a decision were taken by the Product Owner under the Sponsor's delegated authority (charter §7). Each is conservative, configurable where it is a number, PAPER only, and recorded in `docs/open-questions.md` (OQ-B3, OQ-T1 to OQ-T5).

## Regression suites

| Suite | File | Run |
|---|---|---|
| API integration (real Nest app, Postgres, Redis market fixture) | `apps/api/test/irtc-r2.int.test.ts` | `pnpm --filter @kora/api test:integration -- test/irtc-r2.int.test.ts` |
| Domain unit and property tests (fast-check) | `packages/domain/src/trading/irtc-r2.test.ts` | `pnpm --filter @kora/domain test` |
| Config unit tests | `apps/api/src/trading/trading.unit.test.ts` (R2-13, R2-20 config) | `pnpm --filter @kora/api test` |

**Before** (the reviewed code plus only the new test file): 20 of 20 API regression tests fail, each on the finding's own assertion (the outputs are quoted per finding below). **After:** 20 of 20 pass, 10 of 10 domain tests pass and 11 of 11 config tests pass. The full gate results are at the end of this document.

The one existing test that changed is `trading-integrity.int.test.ts` › daily roll. It now expects the overnight funding in whole cents (`-4.52`, not `-4.5175`), which is the intended R2-07 behaviour.

## Summary

| ID | Sev | Verdict | Fix (short) | Regression test |
|---|---|---|---|---|
| R2-01 | Critical | CONFIRMED | Amend re-runs pre-trade risk on the remainder | `R2-01: amending a working order re-runs pre-trade risk…` |
| R2-14 | Critical | CONFIRMED | FX staleness never holds fills; reducing orders use the last known rate; correct hold reason | `R2-14: with FX closed (weekend)…` + domain `R2-14` |
| R2-02 | High | CONFIRMED | Taker semantics unless the limit was resting on a continuous market; post-only on amend | `R2-02: post-only amended…`, `R2-02: a resting limit gapped through…` |
| R2-03 | High | CONFIRMED | Worst case over working same-side orders + fill-time re-check | `R2-03: several "reducing" orders…` |
| R2-04 | High | CONFIRMED | Guarded users keep a full stop: tighten only; cancel and cancel-all refused | `R2-04: a novice cannot cancel or widen…` |
| R2-05 | Medium | CONFIRMED | Currency change converts cash (two journals), own and platform limits | `R2-05: changing the base currency converts…` |
| R2-06 | Medium | CONFIRMED | Minimum commission once per order | `R2-06: the minimum commission is charged once…` + property |
| R2-08 | Medium | CONFIRMED | Sweep snapshots day/week/month start equity at the UTC boundary | `R2-08: the day-start equity is snapshotted…` |
| R2-09 | Medium | CONFIRMED | Four-eyes re-evaluated under the lock; approval bound to the halt | `R2-09: a firm halt that lands between…` |
| R2-10 | Medium | CONFIRMED | Volatility term per quote sequence | `R2-10: a mid jump taxes only the quote…` |
| R2-11 | Medium | CONFIRMED | Trailing-distance amend recomputes the stop | `R2-11: amending the trailing distance…` |
| R2-12 | Medium | CONFIRMED | Scope 2 keeps protective children (OQ-T1) | `R2-12: kill switch "halt robots + cancel orders"…` |
| R2-19 | Medium | CONFIRMED | DAY on 24h venues ends at the daily break or 17:00 New York (OQ-T3) | `R2-19: DAY orders on 24-hour venues…` |
| R2-20 | Medium | CONFIRMED | Margin call at 100 %, close-out at 50 % (OQ-B3) | `R2-20: margin call below 100%…` |
| R2-21 | Medium | CONFIRMED | Pre-fill account-limit re-check for resting orders | `R2-21: a resting order is re-checked…` + domain `R2-21` |
| R2-07 | Low | CONFIRMED, fixed | Charges rounded in the base currency minor unit (OQ-T4) | `R2-07: charges are booked in the account currency minor unit` |
| R2-13 | Low | CONFIRMED, fixed | `NODE_ENV=production` refuses the session override | unit `IRTC R2-13…` |
| R2-15 | Low | CONFIRMED, fixed | Consumed depth tracked per book side and sequence | `R2-15: consecutive orders on one depth snapshot…` |
| R2-16 | Low | CONFIRMED, fixed | Stop types refuse IOC/FOK; trailing refuses limit/stop price | domain `R2-16: order shape` |
| R2-18 | Low | CONFIRMED, fixed | Own limits must be > 0; division guarded | `R2-18: a zero own limit is refused` |
| R2-26 | Low | CONFIRMED, fixed | Robot amends refused while halted; real hold reason | `R2-26: a robot cannot amend…` (+ R2-14 flatten) |
| R2-22 | Low | CONFIRMED (code reading), logged | Needs position attribution (B-408) | — |
| R2-23 | Low | CONFIRMED (code reading), logged | Swap roll calendar (B-304) | — |
| R2-24 | Low | CONFIRMED (code reading), logged | Financing and short-selling policy (OQ-R5) | — |
| R2-25 | Low | CONFIRMED (code reading), logged | api→quant contract uses JSON numbers | — |

---

## Critical

### R2-01 — Amending an order bypasses every pre-trade risk limit
- **Verdict:** CONFIRMED. Before the fix, `PATCH qty=50000000` on a 10k working limit returned **200** and the order held 50,000,000.
- **Root cause:** `OmsService.amend` ran only the grid and fat-finger checks. It never ran `evaluate()`, and the engine never re-checked risk at fill time.
- **Fix:** `apps/api/src/trading/oms.service.ts` `amend` → `amendViolations()`.
  - Any amend that raises the size or moves a price (limit, stop or trailing distance) re-runs the full `evaluate()` on the amended order's unfilled remainder, inside the account lock.
  - The order itself is excluded from the working-order aggregate (and so is its OCO group).
  - The response is 422 with the same codes as a new order (`MAX_ORDER_NOTIONAL`, `MAX_POSITION`, `MAX_LEVERAGE`, `INSUFFICIENT_MARGIN`, the loss limits and so on).
  - Rules that only concern how an order is entered are exempt on amend (`AMEND_EXEMPT_CODES`): order rate, Novice order type and entry stop, fill-now market checks, entry bracket sides, and reduce-only clipping.
  - A pure size reduction is always allowed.
  - Defence in depth: R2-21.
- **Test:** `R2-01: amending a working order re-runs pre-trade risk (qty increase past every limit is refused)`. It asserts 422 with the four limit codes, the quantity unchanged, and that a later fill books only the approved 20,000.
- **Evidence:** before `expected 200 to be 422`; after ✓.

### R2-14 — Non-USD accounts: stops do not trigger, closes and flatten are held when FX is closed
- **Verdict:** CONFIRMED. The scenario is an EUR account holding BTCUSD on a Saturday, with the EURUSD quote from Friday. Before the fix, the stop did not fire and the position stayed at **0.5**.
- **Root cause:**
  - `PaperEngineService.work` returned early when `!rate.fresh`, before any trigger logic.
  - `evaluateRisk` raised `FX_RATE_UNAVAILABLE` for every order, reducing ones included.
  - The kill-switch hold reason was derived only from the market snapshot.
- **Fix:**
  - Engine: only a *missing* FX route holds an order. A stale rate is used as the last known rate and the fill is flagged `fills.fx_stale = true` (migration `0110_irtc_r2_trading.sql`, audit payload `fxStale`).
  - Domain: new `RiskContext.fxRateKnown`. `FX_RATE_UNAVAILABLE` is not raised for a reducing order when a last rate exists. New exposure still needs a fresh rate.
  - OMS passes `fxRateKnown: !!rate`.
  - Kill switch: the flatten reason comes from `PaperEngineService.holdReason()` (market data, session, missing FX route, cancelled, or depth).
  - Valuation already flags positions `stale` when the rate is not fresh.
- **Tests:**
  - API `R2-14: with FX closed (weekend) a non-USD account still gets its stop, can close, and flatten works`. The stop fires, the stop fill has `fx_stale = true`, a reduce-only close preview has no `FX_RATE_UNAVAILABLE`, an opening preview still gets it, and kill-switch flatten returns `positionsFlattened: 1` with no pending.
  - Domain `R2-14: FX staleness never blocks reducing orders`.
- **Evidence:** before `expected '0.5' to be '0'`; after ✓.

## High

### R2-02 — A limit made marketable by an amend or a gap fills at its limit as maker; post-only takes liquidity
- **Verdict:** CONFIRMED. Before the fix, a post-only amend to 1.09400 returned **200** and filled at 1.09400 as maker. A resting 1.08000 buy gapped through to an ask of 1.07900 filled at **1.08**.
- **Root cause:** the resting-limit branch of `work()` always priced `[qty @ limit]` as maker when `arrival = false`, and the amend path never re-checked `postOnly`.
- **Fix:**
  - `paper-engine.service.ts` keeps `restedAt`: when the limit was last seen *not marketable* on a safe, open market. That is refreshed on every matching pass and every 1 s sweep.
  - Maker-at-limit applies only when the order was resting within the instrument's staleness window, i.e. the market moved onto it continuously.
  - Otherwise the limit takes liquidity: `walkBook` capped at the limit, taker fees, never worse than the limit. "Otherwise" covers the first pass after placement, amend (`forget()` clears the marker), trigger, or a pause such as a closed session or an unsafe feed, where the market gapped through it.
  - `amend` refuses a post-only order whose new limit would cross (`POST_ONLY_WOULD_TAKE`).
- **Tests:** `R2-02: post-only amended across the spread is refused; a crossed limit fills as a taker at the touch` and `R2-02: a resting limit gapped through after a pause fills at the market, not at its limit`.
- **Evidence:** before `expected 200 to be 422` and `expected 1.08 to be less than or equal to 1.079`; after ✓.

### R2-03 — Several "reducing" orders together flip the position past the limits
- **Verdict:** CONFIRMED. Long 900k, then five SELL LIMITs of 900k: all five were accepted before the fix (`expected 0 to be greater than 0` rejections).
- **Root cause:** "reducing" was judged per order against the filled position only.
- **Fix (two layers):**
  1. `OmsService.evaluate` judges a *resting* order on the worst case. `positionQtyBefore` is the position plus the unfilled remainder of every other working same-side order that can add exposure (`workingSameSide()`: reduce-only orders excluded, an OCO group counted once at its largest leg).
     - Orders that fill now (market, IOC/FOK, marketable limits) act on the actual position, so a closing market order is never blocked by a working take-profit.
     - Reduce-only orders use the actual position; the engine clips them.
     - Margin-after is computed on the same worst case.
  2. R2-21: every fill that adds exposure is re-checked, so no combination of working orders can exceed the limits.
  - Policy recorded as OQ-T5.
- **Test:** `R2-03: several "reducing" orders cannot together flip the position past the limits`. At least one order is rejected with `MAX_POSITION`, and after every fill gross exposure ≤ the max position and leverage ≤ the max leverage.
- **Evidence:** before `expected 0 to be greater than 0`; after ✓.

### R2-04 — A novice can cancel or widen the mandatory stop loss after entry
- **Verdict:** CONFIRMED. Before the fix, widening the SL child to 61600 returned **200**, and so did cancelling it.
- **Root cause:** the Novice stop rule existed only on entry (`NOVICE_STOP_REQUIRED`). Amend, cancel and cancel-all had no guardrail.
- **Fix (`oms.service.ts`), for guarded users (novice-only, or anyone in the Novice view):**
  - The `stop_loss` child of an open position can be amended only to *tighten* it. Widening or a quantity change → 422 `NOVICE_STOP_REQUIRED`.
  - Cancelling it → 422 `NOVICE_STOP_REQUIRED`.
  - `DELETE /orders` (cancel all) skips it.
  - Closing the trade still removes the stop, through the existing reduce-only sync.
  - The controller now passes the caller's roles to `cancel` and `cancelAll`.
  - Policy recorded as OQ-T2.
- **Test:** `R2-04: a novice cannot cancel or widen the protective stop of an open position`. Widen, shrink and cancel are refused, cancel-all keeps the stop, tightening is allowed, and closing the trade cancels the stop.
- **Evidence:** before `expected 200 to be 422`; after ✓.

## Medium

### R2-05 — Base currency change relabels the cash; limits unit-less
- **Verdict:** CONFIRMED. Before the fix, a JPY account showed cash **100000** JPY.
- **Root cause:** `updateSettings` only changed `base_currency`.
- **Fix:**
  - `accounts.service.ts` posts `depositReversalJournal(old cash, old ccy)` (kind `adjustment`) plus `depositJournal(converted, new ccy)` at the current mid, so each journal has one currency and cash equals the ledger.
  - It converts `starting_cash` and the own money limits, pending loosenings included (`convertOwnLimits`).
  - It records `settings.limitFx` (platform currency → new currency). `platformDefaults()` converts the platform money limits with it, so a limit keeps its value.
  - With no FX route at all → 409 `fx_unavailable`.
  - The audit payload carries the conversion.
  - Policy recorded as OQ-T4.
- **Test:** `R2-05: changing the base currency converts the starting cash and the platform limits`. Cash and starting cash are 14,821,500 JPY, the daily loss limit is ≈ 5,000 × 148.215, and the ledger cash equals `accounts.cash`.
- **Evidence:** before `expected '100000' to be '14821500'`; after ✓.

### R2-06 — Minimum commission charged per depth level; the preview shows one
- **Verdict:** CONFIRMED. Before the fix, 300 AAPL over three levels was charged **3.00** against a preview of 1.50.
- **Root cause:** `commission()` with its minimum was applied to each fill piece.
- **Fix:**
  - Domain `commissionRaw`, `orderCommission` and `incrementalCommission`.
  - The engine sums the raw commission of the order's earlier fills and charges only the increase of the order total (the minimum applied once). The fills of an order therefore always add up to the preview's single commission.
- **Tests:**
  - `R2-06: the minimum commission is charged once per order, as the preview shows` (1.50 over three levels; 1.00 over ten one-share levels).
  - Domain property `R2-06 … however an order is split, its fills add up to one order commission` (500 runs).
- **Evidence:** before `expected '3.00' to be '1.50'`; after ✓.

### R2-08 — The daily loss baseline is the first valuation of the day
- **Verdict:** CONFIRMED. Before the fix, the Thursday BUY after an overnight loss of −7.4k was **201 filled**.
  - Note: the test first lets the Wednesday async account publish settle. Without that, a delayed publish valued on Wednesday could create Thursday's snapshot and mask the bug.
- **Root cause:** `periodStart` inserted the equity at the account's first valuation of the period.
- **Fix:**
  - `AccountsService.snapshotPeriodStarts()` values every account with a position or a working order that has no snapshot for today, which records the day, week and month start equity.
  - `EngineLoopService.sweep` calls it once per UTC date, at the first sweep after the boundary.
  - B-308 is marked partly done. Customer time zones stay open with B-803.
- **Test:** `R2-08: the day-start equity is snapshotted at the roll, so a loss before the first request counts` → 422 `DAILY_LOSS_LIMIT`.
- **Evidence:** before `201` (the order body was returned instead of 422); after ✓.

### R2-09 — Resume TOCTOU lifts a firm halt without four eyes
- **Verdict:** CONFIRMED (forced interleaving). Before the fix: `resumed = true`, account not halted.
- **Root cause:** `resumeNeedsFourEyes` was evaluated on a row read outside the lock, and `executeResume` did not re-check it.
- **Fix:**
  - `executeResume` re-evaluates the policy on the locked row when there is no approval and returns 409 `four_eyes_required`.
  - Approvals carry the `haltedAt` / `haltedBy` they were requested for (`four-eyes.service.ts` passes them from the request payload). A different halt returns 409 `halt_changed`.
- **Test:** `R2-09: a firm halt that lands between the policy check and the resume is not lifted without four eyes`.
- **Evidence:** before `expected true not to be true`; after ✓.

### R2-10 — The volatility slippage term is process-global and sticky
- **Verdict:** CONFIRMED. Before the fix, after a +100 pip jump and a new quote with an unchanged mid, the buy filled at **1.09603** against an ask of 1.09421.
- **Root cause:** `prevMid` changed on any `snapshot()` call and the last move was reused until the mid changed again.
- **Fix:**
  - `MarketViewService` keys the move by quote sequence: `lastMidMove = |mid − previous quote's mid|` for the quote that made it.
  - A new quote with the same mid resets it to 0, and a move across a pause (older than the staleness window) counts as 0.
  - Previews can no longer change it.
- **Test:** `R2-10: a mid jump taxes only the quote it happened on; previews do not move the volatility term` (fills at 1.09421).
- **Evidence:** before `expected '1.09603' to be '1.09421'`; after ✓.

### R2-11 — Amending a trailing distance has no effect until a new extreme
- **Verdict:** CONFIRMED. Before the fix, the stop stayed at **1.07919** after `trailAmount = 0.00050`.
- **Root cause:** `stop_price` was recomputed only when the trailing reference changed.
- **Fix:** `amend` sets `stop_price = trail_ref_price ∓ new trail` immediately. The following `work()` triggers the stop if the market has already crossed it.
- **Test:** `R2-11: amending the trailing distance moves the stop at once` (stop 1.08369; filled when the bid reaches 1.08300).
- **Evidence:** before `expected '1.07919' to be '1.08369'`; after ✓.

### R2-12 — Kill switch scope 2 strips protective stops
- **Verdict:** CONFIRMED. Before the fix, 2 orders were cancelled (the entry and the SL), leaving the position unprotected.
- **Root cause:** `cancelAllOpen` cancelled every open order.
- **Fix:**
  - `cancelAllOpen(…, { keepProtective })`. Scope `robots_cancel` keeps the `stop_loss` / `take_profit` children, which are reduce-only and are cancelled automatically when the position is flat.
  - Scope 3 (flatten) still cancels everything and flattens.
  - Decision recorded as OQ-T1.
- **Test:** `R2-12: kill switch "halt robots + cancel orders" keeps the protective stops of open positions`.
- **Evidence:** before `expected 2 to be 1`; after ✓.

### R2-19 — DAY orders on 24-hour venues live until the Friday close
- **Verdict:** CONFIRMED. Before the fix, a Monday EURUSD DAY order expired on **Friday 21:00Z**.
- **Root cause:** `dayExpiry` searched only for open → closed, and the FX calendar is contiguous from Sunday to Friday.
- **Fix:**
  - When the next close is more than 24 h away, the day ends at the venue's daily break (the CFD 16:00–17:00 Chicago break) or at the 17:00 America/New_York roll (`nextDayRoll`), whichever comes first.
  - Exchange venues and 24/7 venues are unchanged.
  - Policy recorded as OQ-T3.
- **Test:** `R2-19: DAY orders on 24-hour venues end at the 17:00 New York roll, exchange venues unchanged`.
  - EURUSD: Monday → Monday 21:00Z; after the roll → the next day; winter → 22:00Z.
  - US500 → Wednesday 21:00Z.
  - AAPL → 20:00Z.
  - BTC → UTC midnight.
- **Evidence:** before `expected '2026-10-02T21:00:00.000Z' to be '2026-09-28T21:00:00.000Z'`; after ✓.

### R2-20 — No margin close-out
- **Verdict:** CONFIRMED (code reading plus reproduction). Before the fix there was no margin call or close-out at any level.
- **Decision (OQ-B3):** Product Owner, delegated Sponsor authority, PAPER only. Margin level = equity ÷ margin used.
  - A margin-call alert at ≤ 100 %.
  - Automatic close-out at ≤ 50 %, largest unrealised loss first, one whole position at a time until the level is above 50 %.
  - Placed through the normal engine path by the system with full audit.
- **Fix:**
  - New `apps/api/src/trading/margin.service.ts`, run from the engine sweep every `KORA_MARGIN_CHECK_MS` (default 5000).
  - Levels come from `KORA_MARGIN_CALL_LEVEL_PCT` (100) and `KORA_MARGIN_CLOSEOUT_LEVEL_PCT` (50). The config refuses a close-out level ≥ the call level.
  - An unlocked pre-check; the account lock is taken only at or below the call level.
  - A `risk.margin_call` alert and `account.margin_call` audit once per episode.
  - A `risk.margin_closeout` alert and audit, then a reduce-only market order with source `margin-closeout` (migration 0110 extends the source check), actor `system:margin-monitor`.
  - Held orders (closed market) fill at the first safe quote; meanwhile the next-largest loser is tried.
  - Pre-trade: R2-01 and R2-03 close the paths that created the excess.
- **Test:** `R2-20: margin call below 100% margin level, close-out of the largest loser below 50%`. At 80 % there is an alert and no close. At 40 % EURUSD is closed and GBPUSD is kept, with source `margin-closeout` and an audit actor type of `system`. Config unit test `IRTC R2-20…`.
- **Evidence:** before `expected [] to include 'risk.margin_call'`; after ✓.

### R2-21 — Resting orders are never re-checked before they fill
- **Verdict:** CONFIRMED. The scenario is a 100k resting buy at 1.07500 that becomes marketable after an 8.3k loss on the long, past the 5k daily limit. Before the fix it **filled**.
- **Root cause:** the engine filled resting orders with no account-level risk.
- **Fix:**
  - Domain `evaluateFillExposure()` (shares `accountLimitViolations()` with `evaluateRisk`): margin, leverage, max position, daily/weekly/monthly loss, the Novice borrowing cap and cooling-off, and the robot halt. It is skipped for fills that reduce the position.
  - The engine calls the OMS-registered `FillGuard` before any non-arrival fill of a non-reduce-only order: resting limits, triggered stops, trailing stops, held market remainders, amended orders.
  - A refused fill cancels the order with `cancel_reason = risk_recheck:<CODE>`, audits `order.risk_recheck_failed` (codes plus message) and raises a `risk.limit_breach` alert.
  - Protective, kill-switch and close-out orders are reduce-only and never blocked.
- **Tests:** API `R2-21: a resting order is re-checked before it fills (daily loss limit hit after acceptance)`; domain `R2-21: re-check before a resting order fills` (4 tests).
- **Evidence:** before `expected 'filled' to be 'cancelled'`; after ✓.

## Low

| ID | Verdict | Fix or log | Test / evidence |
|---|---|---|---|
| R2-07 | CONFIRMED (JPY commission `8.8929`) | Commission and the FX conversion fee are converted to the base currency, then rounded once to its minor unit. Overnight funding and its fee are rounded the same way, and a zero charge is skipped. The rule is documented in `money.ts` and OQ-T4. | `R2-07: charges are booked in the account currency minor unit (JPY: whole yen)`; before `expected '8.8929' to match /^\d+$/` |
| R2-13 | CONFIRMED | `loadTradingConfig` treats `NODE_ENV=production` as production even when `KORA_ENV` is unset (the same predicate as `config.ts`) | unit `IRTC R2-13: NODE_ENV=production refuses the session override…` |
| R2-15 | CONFIRMED (three IOC orders on one snapshot all filled at the same price) | `bookUse`: size consumed per (symbol, side, depth seq), subtracted before the next walk on the same snapshot | `R2-15: consecutive orders on one depth snapshot do not re-use the same liquidity` (1.08421, 1.08431, 1.08441) |
| R2-16 | CONFIRMED | `orderShapeIssues`: stop, stop-limit and trailing refuse IOC and FOK; trailing refuses `limitPrice` and `stopPrice` (400 with a message; the Pro ticket shows it) | domain `R2-16: order shape` |
| R2-18 | CONFIRMED (`dailyLossUsedPct: "NaN"`) | Own limits must be > 0 (400); the view guards the division | `R2-18: a zero own limit is refused (no NaN in the account view)`; before `expected 200 to be 400` |
| R2-26 | CONFIRMED | `amend` refuses robot actors while halted (422 `TRADING_HALTED`). The flatten reason comes from `holdReason()` (see R2-14). | `R2-26: a robot cannot amend orders while the account is halted`; before `promise resolved … instead of rejecting` |
| R2-22 | CONFIRMED (code reading) | **Logged.** A robot's stop is cancelled when manual trades net the position flat. The fix needs position-level source attribution (B-408). Owner: S4, with S2 for robot book semantics. | — |
| R2-23 | CONFIRMED (code reading) | **Logged.** The swap roll runs at a fixed UTC hour, a missing mark skips the night, and there is no triple-swap or holiday handling. This is part of B-304 (roll calendar). The 17:00 New York roll helper (`nextDayRoll`) now exists for reuse. Owner: S2 / S4. | — |
| R2-24 | CONFIRMED (code reading) | **Logged.** Unlevered positions and cash equities are financed CFD-style, and novices can short equities. This is a product and policy decision (OQ-R5, financing per asset class). Owner: S8, then the Sponsor. | — |
| R2-25 | CONFIRMED (code reading) | **Logged, owner-accepted.** The robot signal context sends prices as JSON numbers because that is the api→quant contract (bars are numbers too). Stops and targets returned by quant are converted with `dec(x.toFixed(12))` and rounded to the tick in Decimal before submission, so there is no ledger impact. Changing the contract belongs to the quant/robot owners (S5 / S3); the `ref * 10` sentinel should be replaced at the same time. | — |

## Other changes made while correcting

- `EngineLoopService` margin interval: it tolerates the clock moving backwards (NTP adjustment, or the test clock), which would otherwise suspend margin checks.
- `AccountSettingsSchema` rejects zero limits. `/novice/limits` has its own schema and was not changed.
- The OCO legs of an amended order are excluded from the working-order aggregate (the legs are alternatives).

## Full gate (after)

The results are in the Project Owner's corrector report for this worktree (branch `worktree-agent-aee6022ce73e6f51e`): build, lint, typecheck, unit tests, integration tests (run twice), e2e, and `py:check`.
