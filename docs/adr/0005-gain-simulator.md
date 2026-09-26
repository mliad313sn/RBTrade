# ADR 0005 — Gain simulator: engine, determinism, numbers and service boundary

- Status: Accepted (2026-09-26)
- Deciders: S5 (quant developer, lead), S2 (senior trader / quant), S6 (frontend), S3 (architect)
- Related: [plan 05](../plans/05-gain-simulator.md), [model](../quant/monte-carlo.md), [reality checks](../quant/reality-checks.md)

## Context

Goal 05 needs an honest Monte Carlo simulator with these properties:

- costs on by default;
- distributions, never a single line;
- reality checks;
- a block bootstrap of real trade lists;
- paper-account analytics;
- 10k paths × 1,000 trades in under 1.5 s (p95);
- seeded determinism;
- caching by input hash.

Goals 03 (fills) and 06 (backtests) do not exist yet. Goal 02 was being built in parallel.

## Decisions

1. **Engine: numpy draws plus one numba kernel.**
   - `numpy.random.Generator(PCG64(seed))` draws one uniform per trade, in chunks of 2,048 paths.
   - A single-threaded `@njit(cache=True, nogil=True)` kernel does the path accounting: sizing, costs, ruin floor, withdrawals, drawdown, streaks and time under water.
   - Only period-end equity is stored, so memory is `paths × periods`, not `paths × trades`.
   - Measured: 10k × 1,000 end to end in 130–165 ms p95, about 10× under the budget (`services/quant/bench/RESULTS.md`).
   - *Rejected:* `prange` parallelism, because results would depend on thread scheduling and we don't need the speed. Also rejected: a per-path counter-based RNG in numba (more code for no gain) and pure numpy vectorisation (the running peak, ruin stop and streaks are sequential).
2. **Determinism contract.** The same request, seed included, gives byte-identical JSON except `elapsedMs` and `cache`. The chunked draw consumes the PCG64 stream in row-major order, so chunk size does not change results. A test checks this.
3. **Caching.** An in-process LRU of 128 entries keyed by `sha256(kind + canonical request JSON)`. Results are deterministic, so the cache can never be stale. A shared Redis cache is not needed at this volume. If the quant service scales out, we revisit this (BACKLOG B-503).
4. **Numbers: simulation floats, paper money Decimal.** Simulation inputs and outputs are **statistical parameters and estimates**, so they are float64 on the wire and in the UI. They are never booked, never summed into balances and are always labelled SIMULATED. This is a scoped exception to the master rule "money is decimal", which still holds for anything booked. Paper-account analytics computes P&L with `decimal.Decimal` from decimal-string fills; only ratios become floats. The web formats simulation numbers with its own helpers (`apps/web/src/lib/sim/format.ts`). `formatMoney`/`Decimal` stay reserved for booked values.
5. **Service boundary.**
   - The browser calls only the api (`/api/sim/*` through the same-origin proxy).
   - The api's `SimModule` does four things: validates with zod (plain-language rejections), rate-limits (`KORA_SIM_RATE_LIMIT` per minute per client, default 60), forwards to quant (`QUANT_URL`, timeout `QUANT_TIMEOUT_MS`), and writes an audit event for every run (`sim.projection_run`, `sim.bootstrap_run`, `sim.paper_projection_run`) with the input hash, cache flag, sizes and fired reality checks.
   - The quant service validates again with pydantic (defence in depth, identical limits) and is not exposed publicly.
   - All roles can simulate, because nothing here touches orders or money.
6. **Paper analytics is a pure function over `Fill[]`.**
   - The schema mirrors `packages/domain` `Fill`.
   - Trades are position episodes (flat to flat) with FIFO lots.
   - Fees are cash. Slippage is counted as an embedded cost.
   - Until goal 03 exists, the api feeds a deterministic **SIMULATED fixture** (80 round trips), labelled as such in the response and in the UI. Goal 03 swaps the source (B-501). The contract does not change.
7. **Bootstrap.** Circular moving-block bootstrap with block size `⌈n^{1/3}⌉` by default, or set by the user. Paper trades are resampled as per-trade % returns, applied as traded. Backtest trades (goal 06) can use R multiples and be re-sized.
8. **Honesty in the UI.**
   - Runs are explicit: sliders mark results stale, while toggles and imports re-run. This keeps the audit trail meaningful.
   - Every chart carries a SIMULATED watermark, including in the PNG export. The CSV starts with a SIMULATED header line.
   - Kelly is computed numerically **after costs and fat tails**. The prototype's `p − q/W` would overstate the safe size.
   - Novice Practice uses a deliberately **skill-free** edge: 50% win rate, 1:1 wins and losses, costs, and rare gaps past the safety net. That is the honest default for someone without a tested method, so the typical practice year is slightly negative.
9. **Charts: hand-written SVG, not lightweight-charts.** Fan bands, histograms and overlays are simple polygons. SVG keeps them accessible (a `<title>` summary plus a data table), themable through CSS variables and exportable to PNG without a canvas library. lightweight-charts stays the choice for price charts (goal 04).

## Consequences

- The statistical acceptance tests run in the normal `pytest` suite, in about 6 s:
  - analytic mean within 1% at 50k paths;
  - closed-form risk of ruin within 0.02 absolute;
  - determinism.
  
  A perf guard also runs in CI. The full benchmark is a script whose results are committed.
- The e2e stack now starts the quant service. Playwright runs uvicorn on `E2E_QUANT_PORT`, default 8010.
- Numba JIT compilation takes about 1 s on a cold start. It is cached on disk and warmed in the FastAPI lifespan. Containers set `NUMBA_CACHE_DIR`.
