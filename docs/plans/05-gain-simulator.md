# Plan 05 — Gain Simulator (Monte Carlo projection, bootstrap, reality checks, paper analytics)

Lead seats: S5 (quant developer), S2 (senior trader / quant), S6 (frontend). Gate lenses: S8, S9, S10.
Status: **in progress**. Built in parallel with goal 02 (market data). Goals 03 (paper engine) and 06 (backtests) are not built yet.

## 0. Constraints for this session

- Goal 03 fills do not exist yet. Paper analytics is a **pure function over a `Fill` list** whose schema matches `packages/domain` `Fill` (decimal strings). Until goal 03, the api feeds it a **SIMULATED fixture** (clearly labelled in the response and the UI). Wiring the real fills is backlog B-018.
- Goal 06 backtests do not exist yet. "Import from backtest" is a disabled placeholder naming goal 06.
- Goal 02 is being built in the main tree at the same time. To avoid merge conflicts, goal 05 code lives in its own folders: `services/quant/src/kora_quant/sim/`, `apps/api/src/sim/`, `apps/web/src/components/sim/`, `apps/web/src/lib/sim/`. Shared files get one-line additions only (`app.module.ts`, `playwright.config.ts`, `.env.example`). No migration is needed: runs are recorded in the existing audit log; results are cached in the quant process.

## 1. Files

| Area | Path | What |
|---|---|---|
| Quant models | `services/quant/src/kora_quant/sim/models.py` | pydantic v2 request/response models (camelCase on the wire), hard limits |
| Quant engine | `services/quant/src/kora_quant/sim/engine.py` | numba `@njit` path-accounting kernel, numpy outcome generation, percentile/histogram summaries |
| Edge maths | `services/quant/src/kora_quant/sim/edge.py` | expectancy after costs, stress edge cut, numeric full Kelly, closed-form risk-of-ruin approximation |
| Bootstrap | `services/quant/src/kora_quant/sim/bootstrap.py` | circular moving-block bootstrap indices, automatic block size |
| Reality checks | `services/quant/src/kora_quant/sim/reality.py` | pure rules → `[{code, severity, title, message}]` |
| Paper analytics | `services/quant/src/kora_quant/sim/paper.py` | Decimal FIFO round-trip matching over fills → equity curve, drawdown, win rate, profit factor, expectancy, cost drag, exposure, per-trade returns |
| Cache | `services/quant/src/kora_quant/sim/cache.py` | LRU keyed by SHA-256 of the canonical request JSON |
| Routes | `services/quant/src/kora_quant/sim/routes.py` | `POST /mc/project`, `POST /mc/from-trades`, `POST /analytics/paper`, `POST /reality-checks` |
| Benchmark | `services/quant/bench/bench_mc.py`, `services/quant/bench/RESULTS.md` | 10k paths × 1,000 trades, p95 over 30 runs |
| Docs | `docs/quant/reality-checks.md`, `docs/quant/monte-carlo.md` | rule rationales; model and formulas |
| API | `apps/api/src/sim/*` | `SimModule`: zod schemas, quant client (timeout, error mapping), controller (`/sim/project`, `/sim/from-trades`, `/sim/paper/analytics`, `/sim/paper/project`), SIMULATED paper fixture, own rate limit, audit `sim.*` |
| Web (Pro) | `apps/web/src/app/(app)/simulator/page.tsx`, `apps/web/src/components/sim/*` | assumptions panel, SVG fan chart with watermark, KPI tiles, drawdown histogram, risk table, reality checks, stress + fat-tail toggles, import from paper / backtest, A/B compare, CSV and PNG export |
| Web (Novice) | `apps/web/src/app/(app)/practice/page.tsx`, `apps/web/src/components/sim/Practice*.tsx`, `apps/web/src/lib/sim/practice.ts` | three plain inputs → parameters, good / typical / bad year, band chart, "This is a simulation, not a promise", glossary |
| Tests | `services/quant/tests/test_sim_*.py`, `apps/api/test/sim.int.test.ts`, `apps/web/src/lib/sim/*.test.ts`, `apps/web/e2e/simulator.spec.ts`, `apps/web/e2e/practice.spec.ts` | see §4 |

## 2. Model (summary; full formulas in `docs/quant/monte-carlo.md`)

- Each trade's outcome is in R (multiples of the amount risked). Win with probability `p'` pays `+W`; a loss costs `−1`, or `−m` with fat-tail probability `q` among losses. Every trade pays cost `c` (R), win or lose.
- Stress cuts the gross edge by `s`%: the win rate is lowered so that gross expectancy becomes `(1 − s)·E` (win size and loss structure unchanged). No change when there is no gross edge.
- Sizing: fixed-fractional (`f` of current equity), fixed amount (a constant currency amount), or a Kelly fraction (`k × f*`, where `f*` is the numeric full Kelly after costs and tails).
- Trades per period × horizon periods = trades per path. Withdrawals (a recurring amount per period, plus one-offs) come out at period ends. A path that touches the ruin floor stops trading.
- Random numbers: numpy `PCG64` seeded from `seed`, drawn in fixed-size path chunks so the stream (and so the output) is identical for a given seed, whatever the chunking.
- Outputs: P5/P25/P50/P75/P95 per period, mean per period, final-equity distribution, P(end below start), risk of ruin (+ closed-form approximation for fixed-fractional), max-drawdown median/P95/histogram, time under water, longest losing streak, expectancy after costs, full Kelly and user/Kelly ratio, 3 sample paths (the paths nearest P25, P50 and P75 of final equity), reality checks.
- Bootstrap (`/mc/from-trades`): trades as R multiples (sized fixed-fractional) or as fractional returns (paper account). Circular moving-block bootstrap; block size user-set or `ceil(n^(1/3))`.

## 3. Risks and mitigations

| Risk | Mitigation |
|---|---|
| numba JIT compile (~seconds) on first request | `cache=True` + warm-up in the FastAPI lifespan; benchmark excludes the first compile and says so |
| Memory at 50k paths × long horizons | Outcomes generated in path chunks (2,048); only period-end equity is kept; hard cap `paths × trades ≤ 5e7` with a plain-language rejection |
| Floats vs "money is decimal" rule | Simulation outputs are statistical estimates (float64), never booked. Paper analytics P&L uses `Decimal` end-to-end; only ratios are floats. ADR 0005 records this |
| Misleading single numbers | Every KPI has its distribution next to it; SIMULATED watermark on the chart and in exported CSV/PNG |
| Audit noise from slider drags | Runs are explicit (Run button, toggles, imports); sliders mark the result as stale instead of auto-running |
| Quant service down | api returns 503 `quant_unavailable` with a plain message; UI shows it; nothing is invented |
| Novice jargon | Automated jargon scan in e2e (terms must be absent or inside a glossary link); plain-language copy |
| Merge conflicts with goal 02 | Own folders; one-line additions to shared files; no migration |

## 4. Test plan

- **Statistical** (`tests/test_sim_statistics.py`): mean final equity vs analytic `W0·(1+f·E[R])^N` and `W0 + N·a·E[R]` within 1% at 50k paths with zero costs; risk of ruin vs the drifted-Brownian first-passage approximation with the Broadie–Glasserman continuity correction; seed determinism (byte-identical JSON) and different seeds differ.
- **Performance** (`bench/bench_mc.py`, also a pytest guard): 10k × 1,000 p95 < 1.5 s.
- **Reality checks** (`tests/test_sim_reality.py`): each rule has a firing and a non-firing fixture.
- **Paper analytics** (`tests/test_sim_paper.py`): hand-computed fixtures (FIFO partial closes, flips, fees, slippage, exposure).
- **API** (`apps/api/test/sim.int.test.ts`): zod rejections with explanations, proxy to a stub quant server, audit event on run, rate limit 429, 503 when quant is down.
- **Web unit** (`apps/web/src/lib/sim/*.test.ts`): practice mapping, CSV builder, jargon scan helper.
- **E2E** (`apps/web/e2e/simulator.spec.ts`): set assumptions → project → stress (median drops) → import paper (fixture) → compare A/B → export CSV (download parsed). `practice.spec.ts`: good/typical/bad year, sentence present, jargon scan, axe.

## 5. Acceptance criteria (tick sheet)

Filled in at the end (§6).
