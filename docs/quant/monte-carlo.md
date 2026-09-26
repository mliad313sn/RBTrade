# Gain simulator — model and formulas

Owner: S5 (quant developer), reviewed by S2. Code: `services/quant/src/kora_quant/sim/`. ADR: [0005](../adr/0005-gain-simulator.md).

## 1. Per-trade outcome (parametric, `POST /mc/project`)

Outcomes are in **R**, multiples of the amount risked on the trade (the loss if the stop is hit).

| Event | Probability | Outcome (R, net of cost) |
|---|---|---|
| win | `p'` | `W − c` |
| normal loss | `(1 − p')(1 − q)` | `−1 − c` |
| fat-tail loss (gap through the stop) | `(1 − p')·q` | `−m − c` |

- `p` is the win rate, `W` the average win, `c` the cost per trade (spread, fees, slippage and swap, in R), `q` the fat-tail probability among losses and `m` the fat-tail multiple.
- Average loss: `L̄ = 1 + q(m − 1)`.
- Expectancy before costs: `E = p'W − (1 − p')L̄`. After costs: `E − c`.
- **Stress** cuts the gross edge by `s`: `p' = ((1 − s)E + L̄)/(W + L̄)`, so the stressed expectancy is `(1 − s)E`. Win and loss sizes are unchanged. There is no change when `E ≤ 0`.
- **Draws:** one uniform `u` per trade. `u < p'` is a win. Otherwise `(u − p')/(1 − p')` is itself uniform and decides the fat tail.

## 2. Sizing and accounting (numba kernel `account_paths`)

| Model | P&L of a trade with outcome `x` |
|---|---|
| fixed-fractional | `x · f · equity` (`f = riskPct/100`) |
| Kelly fraction | as fixed-fractional with `f = k · f*` |
| fixed amount | `x · A` (constant currency amount per 1 R) |

- Trades per path: `N = tradesPerPeriod × horizonPeriods`. Equity is recorded at each period end.
- **Withdrawals:** a recurring amount per period plus one-offs, taken at period ends. They lower the running peak by the same amount, so they do not count as drawdown.
- **Ruin:** once equity ≤ `ruinFloorPct% × start`, the path stops trading and stays there. Equity never goes below 0.
- **Max drawdown:** the largest `(peak − equity)/peak` over every trade.
- **Time under water:** the number of period ends with equity below the running peak.
- **Longest losing streak:** the longest run of trades with `x < 0`.

## 3. Randomness and determinism

- One `numpy.random.Generator(PCG64(seed))` per run.
- Outcomes are drawn in path chunks of 2,048 × `N`, in row-major order. The stream is identical to one big draw, so a seed always gives the same output. `elapsedMs` and `cache` are the only fields that vary.
- The kernel is single-threaded on purpose (`nogil`, no `prange`). Parallel scheduling would otherwise change results.
- The 10k × 1,000 run takes about 150 ms, so the budget does not need threads (`services/quant/bench/RESULTS.md`).

## 4. Outputs

- **Bands:** P5, P25, P50, P75 and P95 of equity per period, plus the mean.
- **Sample paths:** the paths ranked at the 25th, 50th and 75th percentile of final equity. They are deterministic and show how bumpy a single account is compared with the smooth median.
- **Final equity:** percentiles, mean, and a 20-bin histogram over [P0.5, P99.5] with the ends clipped into the edge bins.
- **Drawdown histogram:** fixed 5% bins from 0 to 70%, plus a "70%+" bin (edges end at 1.0).
- `probEndBelowStart` and `riskOfRuin` (the share of paths that touched the floor).

### Full Kelly

`f*` maximises `G(f) = E[ln(1 + f·X)]` over the **net-of-cost** outcome distribution, fat tails included. `G'(f) = E[X/(1 + fX)]` is strictly decreasing, so `f*` is found by bisection on `0 ≤ f < 1/|min X|`. `f* = 0` when `E[X] ≤ 0`. For a binary edge with no cost this reduces to `p − (1 − p)/W`. The tests check both this form and the form with costs, `(p(W−c) − (1−p)(1+c)) / ((W−c)(1+c))`.

The ratio shown is user fraction / `f*`. For fixed-amount sizing, the user fraction is `A / start`.

### Risk-of-ruin approximation (fixed-fractional, no withdrawals)

Log equity is a random walk with per-trade drift `μ = E[ln(1 + fX)]` and variance `σ² = Var[ln(1 + fX)]`. For a Brownian motion with drift and a lower barrier at `−b`, where `b = −ln(floor)`, the first-passage probability by time `T = N` is:

```
P(ruin by T) = Φ((−b − μT)/(σ√T)) + exp(−2μb/σ²) · Φ((−b + μT)/(σ√T))
```

Trades are discrete, so the barrier is shifted outward by `β·σ` with `β = 0.5826` (Broadie, Glasserman and Kou, 1997).

The acceptance test compares this with the Monte Carlo ruin rate at 50k paths on five cases, with ruin rates from 6% to 90%. The tolerance is an absolute difference below 0.02. The observed differences are 0.002 to 0.006.

## 5. Block bootstrap (`POST /mc/from-trades`)

- **Input:** a trade list either as R multiples (sized fixed-fractional at `riskPct`, with an optional extra cost in R) or as per-trade **percentage returns** (the paper account: net P&L ÷ equity at entry, applied multiplicatively as traded).
- **Method:** circular moving-block bootstrap. Each path joins `⌈N/b⌉` blocks of `b` consecutive trades. Each block starts at a uniformly random index and wraps around the end of the list.
- **Automatic block size:** `b = ⌈n^{1/3}⌉` (Hall, Horowitz and Jing 1995 rate). The user can set `b` (1 ≤ `b` ≤ n).
- Blocks keep streaks and regime clustering that an i.i.d. resample destroys. `test_block_bootstrap_keeps_streaks_that_iid_breaks` shows this.
- Each index is uniform, so the bootstrap mean per trade equals the sample mean. `test_bootstrap_mean_matches_resampled_mean` checks the compounded mean within 1% at 50k paths.
- Reality checks run on the empirical statistics: win rate, average win ÷ average loss, expectancy, sample size and source.

## 6. Limits (validated in the api with zod and again in the quant service with pydantic)

| Input | Range |
|---|---|
| paths | 100 – 50,000 (default 10,000) |
| trades per path | ≤ 5,000 |
| paths × trades | ≤ 50,000,000 |
| win rate | 1 – 99% |
| average win | 0.05 – 20 R |
| cost per trade | 0 – 5 R |
| risk per trade | 0 – 25% (above 2% triggers a reality check) |
| fat-tail probability / multiple | 0 – 50% / 1 – 20 R |
| stress edge cut | 0 – 100% |
| ruin floor | 0 – 99% of start |
| imported trades | 2 – 20,000 |

## 7. Caching

Results are kept in an in-process LRU of 128 entries. The key is the SHA-256 of `kind + canonical request JSON`, which covers every field including the seed. A hit returns the stored result with `cache: "hit"`. Results are deterministic, so a cache can never serve a stale answer. Restarting the service empties it.

## 8. Paper-account analytics (`POST /analytics/paper`)

This is a pure function over `Fill[]` (the `packages/domain` schema). Conventions are in the `paper.py` module docstring: position episodes, FIFO lots, Decimal P&L, fees as cash, slippage counted as embedded cost, and exposure as time with any open position.

It returns:
- the equity curve, with drawdown at each fill;
- max and current drawdown;
- win rate, profit factor, expectancy (in currency and %), average win and loss;
- fees and slippage, cost drag (% of starting capital) and cost share of gross wins;
- exposure;
- per-trade % returns, which feed `/mc/from-trades`.
