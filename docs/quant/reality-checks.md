# Reality checks — rules and rationale

Owner: S2 (senior trader / quant), with S5. Code: `services/quant/src/kora_quant/sim/reality.py`. Tests: `services/quant/tests/test_sim_reality.py` (every rule has a firing and a non-firing fixture).

The reality-check engine is a set of **pure rules**. Each takes the assumptions (or the statistics of an imported trade list) and returns zero or more warnings `{code, severity, title, message}`. Severities:

- `critical`: the projection is not credible as entered. The UI lists it first, in the kill/alert colour, with an icon.
- `warning`: the projection may be credible, but a named weakness can mislead.
- `info`: context only (no rule currently emits `info`; the UI shows a neutral "inputs look internally consistent, run the stress test" note when nothing fires).

Rules never block a run. They sit next to the result so the user sees both. The engine is also callable on its own (`POST /reality-checks`).

| Code | Fires when | Severity |
|---|---|---|
| `implausible_edge` | win rate ≥ 60% **and** average win ≥ 2× the average loss | critical |
| `no_edge_after_costs` | expectancy per trade after costs ≤ 0 | critical |
| `above_full_kelly` | fraction risked per trade > full Kelly for the same edge (and full Kelly > 0) | critical |
| `risk_above_2pct` | fraction risked per trade > 2% | warning; critical above 5% |
| `small_sample` | an imported trade list has fewer than 100 trades | warning |
| `in_sample_source` | the imported trades come from an in-sample backtest | warning |

## `implausible_edge`

**Rule.** `winRate ≥ 0.60 && avgWin/avgLoss ≥ 2.0`.

**Rationale.** The two numbers trade off against each other in any real strategy: trend followers win rarely but big, and mean-reversion wins often but small. A 60% hit rate at 2 R has a gross expectancy of `0.6·2 − 0.4 = 0.8 R` per trade. Compounded at 1% risk and 20 trades a month, that is about +17% a month. No persistent, capacity-bearing edge of that size survives competition and costs. Such inputs almost always come from curve fitting, look-ahead bias or a tiny sample. The fat-tail adjustment divides the average win by the average loss (`1 + q·(m−1)`), so fat tails can switch the rule off.

**Not flagged.** 59% at 3 R: rare but seen in short samples. The small-sample and in-sample rules cover those cases.

## `no_edge_after_costs`

**Rule.** `p·W − (1−p)·L̄ − c ≤ 0`. Here `L̄` is the average loss including fat tails and `c` is the cost per trade in R. For imports, the rule uses the mean of the imported outcomes after any extra cost.

**Rationale.** Costs (spread, fees, slippage, swap) are paid on every trade, win or lose. A strategy with a small gross edge can be negative after costs, and more activity then makes it worse. KORA shows costs by default (charter §4.1) and names this failure explicitly.

## `above_full_kelly`

**Rule.** `f > f*`. Here `f` is the fraction of equity risked per 1 R and `f*` is the numeric full Kelly fraction for the **net-of-cost** outcome distribution, including fat tails. `f*` maximises `E[ln(1 + f·R)]`.

**Rationale.** Past full Kelly, the long-run growth rate falls as size rises, and it reaches zero near `2·f*`. Drawdowns keep growing. In practice even full Kelly is too aggressive, because the edge is estimated with error, and professionals use ¼ to ½ Kelly. The UI shows the user/Kelly ratio so the gap is visible below the threshold too. Full Kelly from a bare `p − q/W` ignores costs and tails and overstates the safe size. KORA does not use it.

## `risk_above_2pct`

**Rule.** `f > 0.02` gives a warning; `f > 0.05` gives a critical.

**Rationale.** Losing streaks are normal. At a 45% win rate, a run of 10 losses in 1,000 trades is likely. At 2% risk, 10 straight losses cost about 18% of the account; at 5%, about 40%. The 1–2% band is the long-standing professional convention for discretionary and systematic retail accounts. The message shows the cost of a 10-loss streak at the chosen risk, so the number means something.

## `small_sample`

**Rule.** An imported trade list (backtest or paper) with `n < 100`.

**Rationale.** The standard error of a win-rate estimate is `sqrt(p(1−p)/n)`. At `n = 50` and `p = 0.5` that is ±7 percentage points (1σ), enough to flip the sign of a typical edge. The bootstrap can only resample what it sees. With few trades it understates tail risk, because the worst streak it knows about is the worst one that happened.

## `in_sample_source`

**Rule.** An import with `source = backtest_in_sample`.

**Rationale.** Results on the data a strategy was tuned on are biased upward by selection (data-snooping). Goal 06 provides IS/OOS/walk-forward splits and the deflated Sharpe ratio. The simulator asks for the out-of-sample or walk-forward trade list. The same message appears as a hint under the win-rate slider ("Use out-of-sample results, not in-sample").

## Changing a rule

A threshold change needs an S2 review, an update to this page and to the fixtures in `test_sim_reality.py`, and a line in `docs/STATUS.md`. Rules are advisory. A server-side *block* on silly inputs is done by request validation (`apps/api/src/sim/sim.schemas.ts`), not here.
