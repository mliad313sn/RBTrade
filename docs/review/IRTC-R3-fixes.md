# IRTC R3 corrections: quant and statistics

Corrector: IRTC R3 corrector (independent of the delivery seats). Date: 2026-09-27.
Input: the seat R3 review report (R3-01 … R3-18) and its experiment scripts. Every finding below was
reproduced before it was fixed. Each fix has a regression test that fails on the pre-fix code and
passes after it. Policy values were chosen by the Product Owner under delegated Sponsor authority
(charter §7) and recorded in `docs/open-questions.md`.

## Summary

| ID | Sev. | Verdict | Fix | Regression test |
|---|---|---|---|---|
| R3-01 | High | Confirmed, fixed | Selection ranks on an inner validation segment; the holdout is scored once, for the selected combination | `services/quant/tests/test_bt_selection.py` |
| R3-02 | High | Confirmed, fixed | Trial = configuration + data context; only server-pinned runs count as evidence; holdout DSR ≥ 0.95 and ≥ 90 holdout days | `test_bt_evidence.py`, `evidence.test.ts`, `strategies.int.test.ts`, `promotion.int.test.ts` |
| R3-03 | High | Confirmed, fixed | Dependence-aware edge statistic (time buckets + HAC); replays on a fixed grid so re-scans deduplicate | `apps/api/src/ai/core/edge-stat.test.ts`, `test_scanner_irtc.py` |
| R3-04 | High | Confirmed, fixed | Cross-sectional features match peers by bar start time, not by column | `test_scanner_irtc.py` |
| R3-05 | High | Confirmed, fixed | Guards: at least 8 (scanner) / 12 (backtester) checkpoints, random interior points, whole-prefix comparison, wall-clock cut; "passed" only when something was compared | `test_scanner_irtc.py`, `test_bt_guard.py`, `intel.unit.test.ts` |
| R3-06 | Medium | Confirmed, fixed | Bars a year from the venue session calendar, per instrument | `test_bt_calendar.py`, `sessions.test.ts`, `strategies.int.test.ts` |
| R3-07 | Medium | Confirmed, fixed | An R cost on % returns is refused; the echoed cost is the cost applied | `test_sim_irtc.py`, `sim.int.test.ts` |
| R3-08 | Medium | Confirmed, fixed | VaR and correlation returns joined by date, forming bar dropped | `risk-analytics.test.ts` |
| R3-09 | Low | Confirmed, fixed | Laplace-smoothed isotonic, probabilities bounded to [0.01, 0.99] | `test_scanner_irtc.py` |
| R3-10 | Low | Confirmed, superseded | The UI gate is now the dependence-aware statistic of R3-03 (pooled across the region); `hasSkill` stays a per-instrument diagnostic | — |
| R3-11 | Low | Confirmed, open | Owner: IRTC R4 corrector / S5 (touches `scan.service.ts`) | — |
| R3-12 | Low | Confirmed, fixed | Fold calibrators respect the h-bar embargo | `test_scanner_irtc.py` |
| R3-13 | Low | Confirmed, fixed | Flat-window RSI is 50 (chart parity) | `test_bt_indicators.py` |
| R3-14 | Low | Confirmed, open | Owner: S5 (Monte Carlo UX decision) | — |
| R3-15 | Low | Confirmed, fixed | No drawdown duration on new highs; no CAGR/Calmar under 30 days | `test_bt_metrics_costs.py` |
| R3-16 | Low | Confirmed, open | Owner: S2/S5 (fill model and paper-parity tolerance) | — |
| R3-17 | Low | Confirmed, open | Owner: S6 (chart VWAP anchor per venue session) | — |
| R3-18 | Low | Confirmed, fixed | Tracking replays run with the guard on | `robots.unit.test.ts` |

Migrations: `0130_research_evidence.sql` (R3-02), `0131_calibration_edge.sql` (R3-03).

---

## R3-01 (High): the optimiser selected on the out-of-sample segment

- **Verdict:** confirmed. `research.optimise` sorted by OOS Sharpe and returned `rows[0]` as best;
  the heatmap showed OOS Sharpe per cell.
- **Root cause:** a single IS/OOS split was used both to choose and to evaluate, so the reported OOS
  Sharpe of the chosen configuration was the maximum of N noisy estimates.
- **Fix:** three-way split. The last `validationFraction` (default 0.3) of the pre-holdout bars is the
  validation segment. Optimisation and the heatmap run the engine on data **truncated at the holdout
  start** and rank by validation Sharpe (`rankedBy: "validation_sharpe"`). Only the selected
  combination is then scored on the holdout (`best.holdout`). Result rows carry no OOS numbers. The
  api summary stores `bestValidationSharpe` and `bestHoldoutSharpe`. The heatmap UI says
  "Sharpe (validation, holdout unused)". Walk-forward already chose each fold's parameters on data
  truncated at the training end; a test now pins that. Docs: `docs/quant/backtester.md`, ADR 0006 §5.
- **Regression tests:**
  - replacing every holdout bar with a different random walk leaves the ranking and the chosen
    parameters unchanged;
  - on driftless noise, the chosen configuration's holdout Sharpe ranks uniformly among all 16
    configurations, so it is rarely the holdout maximum;
  - the heatmap cells do not move when the holdout changes;
  - fold 1 of a walk-forward keeps its parameters when every bar after its training window changes.
- **Evidence (6 random walks, 16 combinations):**
  - Before: the reported "OOS" Sharpe was the holdout maximum in **6/6** seeds (values 4.10, 8.81,
    2.91, −1.64, 9.93, 6.84).
  - After: the holdout maximum in **0/6** seeds; reported holdout Sharpes −0.15, 3.32, −0.23, −9.99,
    2.93, 5.16 (mean 0.17, consistent with no edge).

## R3-02 (High): gameable promotion gate and trial count

- **Verdict:** confirmed.
  - The trial key was the parameter hash only, so re-runs on another split, window, symbol set or
    spread added 0 trials.
  - The checklist read "the latest backtest" of any request shape.
  - The gate was a raw OOS Sharpe point estimate.
- **Root cause:** trial identity ignored the data context. Promotion evidence was not pinned to a
  server-chosen design. The gate had no statistical deflation.
- **Fix:**
  - **Trial key** = sha256(configuration hash + data context). The context covers the sorted symbols,
    the data window as UTC days, the split (or the walk-forward design) and the spread override. It is
    stored in `strategy_trials.context` (migration 0130).
  - **Evidence eligibility** is stored on every run (`backtest_runs.gate_eligible` plus `evidence`
    with the reasons it fails). A run is eligible only if it is a standard backtest with the version's
    own parameters and universe, all available history, the default 30 % holdout and the registry
    costs (no `spreadTicks` override). Reason codes: `symbols_override`, `custom_window`,
    `custom_split`, `param_overrides`, `cost_override`, `not_a_backtest`.
  - The **checklist** reads the latest eligible run and adds two items:
    - `oos_length`: at least 90 daily holdout observations;
    - `holdout_dsr`: deflated Sharpe of the holdout ≥ 0.95, with N = every trial recorded for the
      strategy **at the time of the check**. It uses a TS port of `bt/dsr.py` that reproduces the
      paper's example (SR₀ 0.1132, DSR 0.9004).
  - The quant backtest also reports `overfitting.holdout` on the same basis.
  - Policy decided by the Product Owner under delegated Sponsor authority: **OQ-R8a**.
- **Regression tests:**
  - Integration: re-running the same parameters with `oosFraction 0.2`, `spreadTicks 0` or a custom
    `from` adds one trial each and is not eligible (before: `trialsAdded 0`, and it counted as
    evidence).
  - Integration: an ineligible run with OOS Sharpe 5.8 passes nothing (before: `oos_sharpe` passed).
  - Integration: a noise-level eligible holdout (Sharpe 4.28 on 50 days) fails `oos_length` and
    `holdout_dsr`.
  - Statistical: on 20 driftless random walks (about 112 holdout days each, 16 counted trials) the
    deflated holdout gate passes **0/20**, while the old raw gate (OOS Sharpe ≥ 0.8) passes **4/20**
    on the same single honest runs.
- **Note:** trials recorded before 0130 keep their parameter-only hash and still count. A post-0130
  re-run of the same configuration is a new key, which can only increase N (the conservative side).

## R3-03 (High): the "edge after costs" t-test treated dependent predictions as independent

- **Verdict:** confirmed. Two parts:
  - the pooled row-count t-test (`t = mean/sd·√N`) counted overlapping h-bar forecasts and forecasts
    on correlated instruments at the same time as independent;
  - each hourly re-scan replayed a new phase of "every h-th" forecasts, so after h scans every bar had
    an overlapping forecast.
- **Fix:**
  - **Statistic** (`apps/api/src/ai/core/edge-stat.ts`):
    - rows are clustered in time buckets of one typical horizon (the median predicted→resolved span),
      so every forecast in a bucket, on any instrument, is one observation;
    - the bucket means form a series, and the variance of its mean is a HAC long-run variance
      (truncated kernel, lag covering the longest horizon in buckets, never below the plain variance);
    - the bucket count is the effective sample size, and a positive edge needs t ≥ 2 **and ≥ 30
      buckets**.
  - The statistic is rebuilt with the bins and stored in `ai_calibration_edge` (migration 0131).
    `calibrationView` takes it through an optional `edgeStat`; callers that omit it keep the old pure
    function.
  - Bins with no statistic built from their rows (for example seeded demo tables written after the
    last rebuild) can say "none" but never "positive".
  - **Replays:** the quant scanner keeps only forecasts made at a bar close on the fixed calendar grid
    (a multiple of horizon × timeframe) and at least h bars apart. Every re-scan replays the same
    prediction times, and the idempotent insert deduplicates them.
  - Edits to `calibration.ts` were kept to the optional parameter and the decision order, because the
    R4 corrector works in the same file. `scan.service.ts` was not changed.
- **Regression tests:**
  - No-skill world: 8 random walks with pairwise correlation 0.5, a 24-bar forecast every bar, and the
    direction set by past momentum (persistent and shared, no skill on a random walk), over 120 seeds
    with ≥ 30 buckets each. The pooled test calls **45/120** seeds positive (t sd 5.95). The clustered
    test calls **3/120** (t sd 1.14). The nominal rate is about 2.3 %.
  - A real, persistent edge is still detected.
  - The replay times of three consecutive hourly scans are all on the grid and nested (before: a new
    phase each scan).
  - The intel integration test now needs a seeded statistic to display a calibrated probability.

## R3-04 (High): cross-sectional features leaked other instruments' future bars

- **Verdict:** confirmed.
- **Root cause:** the panel is right-aligned per instrument, so a column is not a common clock. For
  an instrument that is stale, halted or on another calendar, `rs_sector`, `rs_index` and the
  `corr_break` index return used peers' later bars at the same column.
- **Fix:** `group_mean_excl` matches peers on the bar start time `t`. A peer counts only if it has a
  bar covering exactly the same interval. Padded cells never match. Per-instrument windows stay in
  instrument time. Docs: panel docstring and ADR 0007b §2.
- **Regression tests:**
  - B's `rs_index` at its last bar equals B's momentum minus A's momentum at the same wall-clock
    time, four columns earlier in A's row;
  - the review's reproduction (B four bars stale, 8-bar horizon) shows skill in **0/4** seeds (4/4
    before; 8/8 in the review);
  - the pre-fix by-column cross-section is now caught by the guard (see R3-05).

## R3-05 (High): vacuous scanner guard; sparse leaks passed the backtester guard

- **Verdict:** confirmed.
  - The api default of 2 checkpoints compared column 0 (warm-up, all NaN) and the last column (prefix
    equals full), yet reported "passed".
  - The backtester compared one row at 8 evenly spaced points.
- **Fix:**
  - **Scanner** (`scanner/guard.py`):
    - at least 8 checkpoints, taken after the warm-up and never at the last time;
    - half spread evenly and half random (seeded from the data, so runs are reproducible);
    - the prefix is cut by **wall-clock time**: every instrument keeps its bars that started at or
      before T;
    - every bar up to T is compared, for every emitted feature.
    - `GuardResult.compared` counts finite values compared. The response carries `compared`, and
      `passed` is false when nothing was compared.
    - `KORA_INTEL_GUARD_CHECKPOINTS` defaults to 8 and cannot go below it.
  - **Backtester** (`bt/evaluate.py`): 12 checkpoints (half random), never the trivial last row, and
    every row 0…t of each prefix is compared.
- **Regression tests:**
  - a next-bar-return leak that respects the warm-up is caught with 1 or 2 requested checkpoints
    (passed with 2 before);
  - the right-aligned cross-section leak is caught (a column-prefix guard cannot see it);
  - a centred 21-bar pivot-flag leak passes the backtester guard in **0/40** series (**17/40**
    before);
  - an all-warm-up scan reports `passed: false`;
  - the api config never goes below 8.
- **Cost:** a guarded scan recomputes the detectors about 9 times (it was 3 times). The intel
  integration scan took about 1.1 s. Large universes should size `KORA_INTEL_TIMEOUT_MS` accordingly.

## R3-06 (Medium): bars a year assumed 24/7

- **Verdict:** confirmed.
- **Fix:**
  - `sessionBarsPerYear(cal, tf, ref)` (domain) counts trading days × session bars over the last 365
    venue-local dates: each session range is rounded up to whole bars, holidays and early closes
    apply, and weekly bars use calendar weeks.
  - The api sends `barsPerYear` per instrument when at least 95 % of the bars fall in trading time
    (`barInSession`, sampled on at most 256 bars).
  - A 24/7 calendar, or a SIMULATED feed that runs outside the sessions (today's default), keeps
    365 × 86,400 / tf.
  - The engine, the guard and `/bt/signal` use each instrument's own figure.
- **Regression tests:**
  - weekday daily bars with 20 % true volatility give a mean 60-bar realised vol of **19.3 %**
    (**23.2 %** with the 24/7 figure);
  - vol-target quantities scale by √(365/252);
  - calendar maths: XNYS 260 days (Christmas) and 259 × 7 + 4 one-hour bars (early close); XTKS lunch
    break 6 bars a day; 24/7 gives 8,760;
  - the api sends about 252 for AAPL daily bars and nothing for 24/7 BTC.

## R3-07 (Medium): Monte Carlo echoed an extra cost it had not applied

- **Verdict:** confirmed.
- **Fix:** `extraCostPerTradeR > 0` with `tradeUnit: pct_return` is refused, by the quant model
  (422) and by the api schema (400), with a plain message. `effective.costPerTradeR` is the cost
  actually applied (0 for % returns). The paper-analytics path already sent 0. Docs:
  `docs/quant/monte-carlo.md`.
- **Regression tests:** pydantic, route and api refusals; the echoed cost lowers the R expectancy by
  exactly that amount.

## R3-08 (Medium): VaR and correlation aligned by position, forming bar included

- **Verdict:** confirmed.
- **Fix:** `alignedDailyReturns` (domain):
  - drops buckets with `t + tf > now`;
  - keeps only dates that every held instrument traded (a 24/7 series folds its weekend into Monday);
  - computes returns between consecutive common dates.
  - `/risk/summary` uses it for VaR and for the correlation clusters. Docs: ADR 0004.
- **Regression tests:**
  - a 24/7 asset hedged against a weekday index that closes at the same weekday prices has **zero**
    VaR and correlation 1 when aligned (position from the end: VaR above 100 on 10,000);
  - the forming bar is excluded;
  - Monday's return spans the weekend.

## Lows

- **R3-09, fixed:**
  - isotonic blocks are Laplace-smoothed ((hits + 1)/(n + 2)), and every calibrator output is bounded
    to [0.01, 0.99];
  - test: 10 no-skill walks produce no out-of-sample pUp ≥ 0.999 or ≤ 0.001 (27 such forecasts with
    only the smoothing, more before).
- **R3-10, superseded by R3-03:**
  - the display gate is now the dependence-aware, region-pooled statistic;
  - the per-instrument `hasSkill` (which needs 30 non-overlapping forecasts) remains a diagnostic.
- **R3-11, open (owner: IRTC R4 corrector / S5):**
  - the stored `predicted` (gross direction probability) is compared with `outcome` (net of cost);
  - fixing it changes `scan.service.ts` and the reliability-line wording, both in the R4 corrector's
    scope;
  - recommendation: store P(net > 0) or show both events.
- **R3-12, fixed:**
  - fold calibrators use only earlier out-of-sample rows with t + h before the fold starts;
  - test: calibrator sizes [0, 171, 366, 561, 756] (before: [0, 195, 390, 585, 780]);
  - the live calibrator's score mismatch is small and was left as documented.
- **R3-13, fixed:** a flat window gives RSI 50 (was 100).
- **R3-14, open (owner: S5):**
  - Kelly sizing with no edge sizes to 0 and shows a flat band;
  - the `no_edge_after_costs` reality check still warns;
  - showing the unsized distribution or refusing is a product decision for the simulator.
- **R3-15, fixed:** a rising curve has 0 drawdown days (was 1), and there is no CAGR or Calmar under
  30 days (a +1 % day was reported as 3,688 %).
- **R3-16, open (owner: S2/S5):**
  - exit fills (stop at the stop, target on touch) are optimistic relative to entries;
  - changing them moves the paper-parity tolerance, so it needs its own change with the parity test.
- **R3-17, open (owner: S6):** the chart VWAP resets at the UTC day; it should anchor to the venue
  session.
- **R3-18, fixed:**
  - the tracking replay calls `/bt/run` with `guard: true`;
  - a static test forbids `guard: false` in the robots, strategies, intel and ai services.

## Gate

The full gate is recorded in the final report of this correction (build, lint, typecheck, test,
test:integration twice, test:e2e, py:check, evals).
