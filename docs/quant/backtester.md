# Backtester, metrics and overfitting controls (goal 06)

Code: `services/quant/src/kora_quant/bt/`. Decision record: ADR 0006. All results are SIMULATED
estimates on SIMULATED data with the registry cost model; nothing here is booked.

## Strategy DSL

`kora.strategy` v1 (`packages/domain/src/strategy/dsl.ts`, mirrored in `bt/dsl.py`). Blocks:

| Block | Content |
|---|---|
| ENTRY | side (long/short) + conditions, all must be true |
| FILTERS | conditions, all must be true |
| EXIT | stop (ATR × m or %), optional target (ATR × m, R multiple or %), trailing stop after x R (ATR × m), time stop (bars), exit conditions (any one exits) |
| SIZE | % equity at risk, fixed quantity, or volatility target; max open positions |

Conditions: `compare`, `cross`, `session_window` (local times in any IANA zone), `venue_open`
(registry calendar per bar), `no_event` (high-impact event within N minutes, SIMULATED calendar),
`ai_regime` (goal 07). Results are tri-state: `true`, `false`, `not_available` (warm-up, no
calendar data, AI regime before goal 07). An unavailable condition never opens a position, except an
`ai_regime` condition set to `whenUnavailable: "ignore"`, which is skipped and recorded.

Indicators (causal, NaN in warm-up): close/open/high/low/volume, EMA (SMA-seeded), SMA, RSI, ATR and
ADX (Wilder), ROC %, highest high / lowest low of the **previous** n bars, realised volatility %.

## Timing and fills (conservative)

1. Decide on the close of bar *t* with bars 0…*t* only.
2. Entries and signal exits fill at the open of bar *t+1*: the touch (mid ± half spread, bid rounded
   down and ask up to the tick) plus the volatility term `ceil_tick(volFactor × |open(t+1) − close(t)|)`.
3. Stops and targets rest from the entry bar. A stop triggers when the exit side of the quote touches
   it (longs: `low − half spread ≤ stop`) and fills **at the stop**; a gap through the stop fills at the
   open's taker price. A target is a limit: it fills at its price when the exit side reaches it.
4. **Both stop and target inside one bar → the stop is assumed first.**
5. Stop and target prices are anchored on the entry reference (the ask for longs, the bid for shorts)
   using distances computed at the decision bar; stops round away from the entry, targets to the
   nearest tick. The live robot uses exactly the same rule on the live quote.
6. Trailing stops tighten on the close (best close since entry − m × ATR) once the trade is x R in
   profit, and apply from the next bar. Time stops and exit conditions exit at the next open.
7. Positions still open at the end are closed at the last close (exit side, with commission) and
   flagged `end_of_data`.
8. Costs: commission per fill (bps of notional + per unit, minimum, half-even to the minor unit),
   overnight funding per 21:00 UTC roll (ACT/360, signed from the customer's view), converted to the
   account currency with the current FX rate (`fxToBase`, an approximation for long histories).

The cost model is built by the api from the same registry rows the paper engine uses (`fee_schedules`,
`asset_class_trading`, the instrument tick/qty grid and multiplier). The spread is the SIMULATED
market's configured spread (`simProfileFor(spec).spreadTicks`), overridable per request. Size larger
than the top of the book (the paper engine's `impactTicks` per extra level) is not modelled and is part
of the parity tolerance.

## Look-ahead guard

Indicators are computed vectorised on the whole series, then the engine recomputes every feature on
`bars[:t+1]` at 12 checkpoints (IRTC R3-05: half spread evenly, half random and seeded from the data,
never the trivial last bar) and requires **every row 0…t** to be identical, not only row *t*. A
sparse leak (a centred pivot flag) passed the old 8-point, single-row check in 17 of 40 random
series; it now fails in every one (`tests/test_bt_guard.py`). Any difference
raises `LookAheadError` and the run fails with HTTP 422 ("used future data"). Tests inject a
future-peeking indicator (must fail) and perturb future bars (past decisions must not change).

## Splits and walk-forward

- IS/OOS: one run over the whole range, segmented by date. Default OOS = the last 30 % of the bars.
  Equity metrics use bar closes inside the segment; trades belong to the segment of their entry.
- Walk-forward: anchored (training window grows) or rolling (fixed length), k folds. With a grid,
  each fold runs every combination on its training window (data truncated at the training end,
  point-in-time) and trades the best by in-sample Sharpe on the next test window. The walk-forward
  result chains the test windows' returns.

## Metrics

Daily (UTC) equity returns; annualisation factor = observed days per year (≈ 365 for 24/7 data,
≈ 252 for weekday data).

| Metric | Definition |
|---|---|
| CAGR | (E_end / E_start)^(365.25 / days) − 1 |
| Sharpe | mean / stdev (ddof 1) × √A |
| Sortino | mean / √mean(min(r, 0)²) × √A |
| Calmar | CAGR / \|max DD\| |
| Max DD, duration | on bar-close equity; longest peak-to-recovery time in days |
| Win rate, profit factor | net P&L per trade; gross wins / gross losses |
| Expectancy | mean R multiple (net P&L / initial risk) and mean currency P&L |
| Exposure | share of bars with an open position |
| Turnover | traded notional / average equity per year |
| Cost drag | commission + spread/slippage + funding / average equity per year |

## Overfitting controls

- **Trials** are counted by the api, not the client: every distinct configuration evaluated for a
  strategy (backtest, optimisation, heatmap, walk-forward grid) is a row in `strategy_trials`, keyed by
  the hash of the definition with its parameter values applied **and its data context** (IRTC R3-02):
  symbols, data window (UTC days), split (or walk-forward design) and cost override. Re-running the
  same parameters with another split, window, symbol set or spread is a new trial.
- **Promotion evidence** (IRTC R3-02, OQ-R8a) is only a *gate-eligible* backtest: the version's own
  parameters and universe, all available history, the default 30 % holdout and the registry costs (no
  `spreadTicks` override). Every run stores `gate_eligible` and the reasons when it is not. The
  checklist deflates that run's holdout Sharpe with **every trial recorded at the time of the check**
  (`holdout_dsr` ≥ 0.95) and needs ≥ 90 daily holdout observations (`oos_length`), next to the raw
  OOS Sharpe and trade-count items. The backtest reports the same basis as `overfitting.holdout`.
- **Deflated Sharpe** (Bailey & López de Prado, 2014) on the in-sample per-period Sharpe with
  N = trials and V[SR] = variance of the recorded trials' in-sample per-period Sharpes; with one trial
  it is the PSR against zero. Reproduces the paper's example (SR₀ = 0.1132, DSR = 0.9004).
- **Sensitivity heatmap** over two parameters (≤ 12 × 12), validation Sharpe per cell (see below),
  current cell outlined.
- **Warnings**: fewer than 100 OOS trades; OOS Sharpe below half the IS Sharpe; no trades.
- **Optimisation**: grid or seeded random search, hard cap `KORA_BT_MAX_COMBOS` (default 200, ceiling
  1,000; larger grids are refused, not truncated), **ranked by validation Sharpe** (IRTC R3-01).

### Selection never reads the out-of-sample holdout (IRTC R3-01)

The data splits three ways: in-sample, validation (the last `validationFraction`, default 30 %, of
the bars before the holdout) and the out-of-sample **holdout** (default: the last 30 % of the bars).
Optimisation and the heatmap run the engine on data **truncated at the holdout start**, so no
holdout bar reaches the engine while combinations are scored; they rank on the validation segment.
The holdout is scored **once**, for the selected combination only (`best.holdout`). Walk-forward
chooses each fold's parameters on that fold's training window only (data truncated at the training
end). Regression tests (`tests/test_bt_selection.py`): replacing the holdout bars leaves the ranking
unchanged, and on driftless noise the selected combination is not the holdout maximum (before the
fix it was, in 6 of 6 seeds, with a mean reported "OOS" Sharpe of about 5).

## Live signal and explainability

`POST /bt/signal` runs the same `decide()` on the last closed bar for the bot runner. Each decision
returns the evaluated conditions (label, result, operand values) and a **contribution** per condition:
`tanh(signed margin / scale)` with scale = ATR(14) for price-like operands (1 % of price during
warm-up), 10 points for RSI/ADX, 1 unit otherwise; positive supports the action. This is a transparent
heuristic, not a model attribution. The api stores it in `robot_signals` (`GET /signals/:id/features`).
