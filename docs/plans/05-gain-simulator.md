# Plan 05 — Gain Simulator (Monte Carlo projection, bootstrap, reality checks, paper analytics)

Lead seats: S5 (quant developer), S2 (senior trader / quant), S6 (frontend). Gate lenses: S8, S9, S10.
Status: **G5 passed, with deferrals** (§6). Verified 2026-09-26 in the cloud build environment: no Docker, native Postgres 16 and Redis 7, Node 22, Python 3.11.15 (and 3.12.3 for the quant suite). Built in parallel with goal 02. Goals 03 (paper engine) and 06 (backtests) are not built yet.

## 0. Constraints for this session

- Goal 03 fills do not exist yet. Paper analytics is a **pure function over a `Fill` list** whose schema matches `packages/domain` `Fill` (decimal strings). Until goal 03, the api feeds it a **SIMULATED fixture** (clearly labelled in the response and the UI). Wiring the real fills is backlog B-501.
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

## 5. Acceptance criteria (Project Owner tick sheet)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1a | With zero costs and a known edge, the MC mean final equity matches the analytic expectation within 1% at 50k paths | **Pass** | `test_sim_statistics.py::test_fixed_fractional_mean_matches_analytic_within_1pct` (3 edges, with and without fat tails; every period of the mean band, not just the end), `test_fixed_amount_mean_matches_analytic_within_1pct`, `test_costs_lower_the_mean_by_the_analytic_amount`, `test_bootstrap_mean_matches_resampled_mean` |
| 1b | Risk of ruin matches the closed-form approximation for fixed-fractional sizing on test cases | **Pass** | `test_risk_of_ruin_matches_closed_form_fixed_fractional`: 5 cases, ruin 6%–90%, absolute difference < 0.02 (observed 0.002–0.006). The formula is drifted-Brownian first passage with the Broadie–Glasserman–Kou correction (`docs/quant/monte-carlo.md` §4) |
| 1c | The same seed gives identical output | **Pass** | `test_same_seed_gives_identical_output` (full JSON, cache cleared between runs), `test_same_seed_identical_for_bootstrap_and_different_seed_differs`; the JIT kernels equal their Python source (`test_sim_engine.py`) |
| 2 | Performance: 10k paths × 1,000 trades in < 1.5 s p95 (benchmark committed) | **Pass** | `services/quant/bench/RESULTS.md`: 30 runs, p95 **163 ms**, max 165 ms (end to end incl. percentiles, histograms and reality checks). CI guard `test_sim_perf.py` (10 runs, p95 < 1.5 s) |
| 3 | Every reality-check rule fires and doesn't fire on the right fixtures | **Pass** | `test_sim_reality.py`: 6 rules × (firing + non-firing fixture at the boundary), a clean fixture fires nothing, severity escalation, and every code documented in `docs/quant/reality-checks.md` (test-enforced) |
| 4 | e2e: set assumptions → project → stress (median drops) → import paper → compare → export CSV | **Pass** (paper = SIMULATED fixture) | `e2e/simulator.spec.ts:27`. Sliders are set (one by keyboard) → Run → response matches the inputs, the expectancy tile equals the analytic 0.17 R, and the chart shows 3 sample paths, the ruin floor and the watermark → pin A → stress toggle re-runs and the median drops (`expect.poll`) → paper import (fixture label, analytics card, `small_sample` check) → A/B table and overlay → CSV download parsed (SIMULATED header, A/B columns, bands). The audit log has the `sim.*` events. The paper fills come from the fixture until goal 03 (B-501) |
| 5 | Novice Practice passes a plain-language review; jargon glossary-linked or absent | **Pass (automated); human review deferred** | `e2e/practice.spec.ts`: the jargon scan over the rendered `main` (outside glossary links) finds none of the 25 Pro terms; every glossary link resolves; the "This is a simulation, not a promise" sentence; good ≥ typical ≥ bad equal P95/P50/P5; axe clean. Human copy review by S1/S8 is B-504 |
| 6 | STATUS update | **Pass** | `docs/STATUS.md` goal 05 section |

Also shipped beyond the criteria: withdrawals, Kelly-fraction and fixed-amount sizing, the full Kelly computed after costs and tails, time under water, the PNG export with the watermark, a closed-form ruin estimate next to the MC value, and axe on the simulator page.

## 6. Deferred with reason

| Item | Reason | Backlog |
|---|---|---|
| Real paper fills | Goal 03 engine not built. Analytics is a pure function over `Fill[]`, tested on hand fixtures. The api feeds a deterministic SIMULATED fixture, labelled in the API response and the UI | B-501 |
| Import from backtest / "Send to Monte Carlo" | Goal 06 not built. The button is present, `aria-disabled`, and explains itself. `/sim/from-trades` already accepts `source` IS/OOS | B-502 |
| Human plain-language review | Needs S1/S8 people-time. The automated jargon scan and glossary are in place | B-504 |
| SDK / OpenAPI regeneration | `packages/sdk/openapi.json` is generated and shared with goal 02. Generation was verified locally (4 `/sim/*` paths) but not committed, to avoid a merge conflict | B-506 |
| OTel spans in quant | Structured logs only (input hash, cache, elapsed) | B-507 |
| CI run on GitHub Actions | This session cannot push. The node job already sets up Python, so e2e can start the quant service | — |

## 7. Verification log (pasted)

```
$ bash scripts/py-check.sh                       (Python 3.11.15)
  ruff check: All checks passed! · ruff format: 26 files already formatted
  mypy --strict: Success: no issues found in 24 source files
  pytest: 85 passed · coverage 98.90% (sim/engine 100%, edge 100%, reality 100%, paper 99%)
$ <py3.12 venv>/pytest                          (Python 3.12.3)
  85 passed · coverage 98.90%
$ .venv/bin/python bench/bench_mc.py --runs 30 --write bench/RESULTS.md
  | 30 | 147 ms | 149 ms | 163 ms | 165 ms | 1500 ms | PASS |
$ pnpm lint        →  Tasks: 10 successful, 10 total
$ pnpm typecheck   →  Tasks: 10 successful, 10 total
$ pnpm test --force → Tasks: 10 successful, 10 total
  @kora/web  Tests 13 passed (practice mapping, CSV, jargon scan, chart helpers, route rules)
  @kora/quant 85 passed · coverage 98.90%   (other packages unchanged and green)
$ pnpm --filter @kora/api test:integration   (real Postgres 16 + Redis 7, db kora_sim_test)
  ✓ test/sim.int.test.ts (18 tests)
  ✓ test/auth.int.test.ts (9) ✓ audit (7) ✓ preferences-killswitch (6) ✓ health (2) ✓ lockout (1)
  Tests 43 passed (43)
$ pnpm build && pnpm test:e2e   (E2E_API_PORT=4015 E2E_WEB_PORT=3015 E2E_QUANT_PORT=8015, db kora_sim_e2e)
  ✓  1 a11y › login and sign-up pages …           ✓ 12 kill-switch › Ctrl+Shift+K …
  ✓  2 a11y › pro shell and novice shell …        ✓ 13 kill-switch › the audit page verifies the chain
  ✓  3 a11y › forbidden page passes axe           ✓ 14 mode › Pro/Novice toggle persists …
  ✓  4 a11y › novice mobile layout …              ✓ 15 practice › three plain questions → good / typical / bad year, no promise, no unlinked jargon
  ✓  5–8 auth › …                                 ✓ 16–17 rbac › …
  ✓  9–11 kill-switch › …                         ✓ 18 simulator › assumptions → project → stress lowers the median → import paper (fixture) → compare A/B → export CSV
                                                  ✓ 19 simulator › PNG export carries the chart and its SIMULATED watermark
                                                  ✓ 20 simulator › import from backtest names goal 06; reality checks flag an implausible, oversized edge
                                                  ✓ 21 simulator › the simulator passes axe (pro-dark) with results on screen
  21 passed
$ node apps/api/dist/openapi-cli.js   → /sim/project, /sim/from-trades, /sim/paper/analytics, /sim/paper/project (not committed, B-506)
```

Prototype check (S1/S6): at 1440×900 the defaults (10k, 1%, 45%, 1.8 R, 0.08 R, 20/month, 24 months, 50% floor, fat tails on) give a median of 19.2k (prototype 19.4k), P5·P95 of 11.6k·32.4k (11.3k·31.7k), a drawdown median/P95 of 17.8%/30.1% (17.7%/29.8%), a 9-trade streak, 21 of 24 months under water and +0.147 R expectancy. These are the same as the artboard's numbers. The prototype used 1,000 paths; we default to 10,000. Kelly differs on purpose: the prototype shows 14.4% (`p − q/W`, before costs), we show 7.1% after costs and tails (ADR 0005 §8).

## 8. Gate review notes (S8 / S9 / S10)

- **S8:**
  - costs are on by default;
  - every projection is a distribution;
  - SIMULATED appears on the chip, the chart watermark, the PNG and the CSV header;
  - the `[XX]%` regulatory placeholder is kept in the disclaimer;
  - the fixture is labelled wherever it appears;
  - the Practice edge is skill-free (OQ-Q1).
- **S9:**
  - inputs are validated twice (zod in the api, pydantic in quant) with hard work budgets (paths × trades ≤ 5e7), so heavy requests cannot overload the service;
  - per-client rate limit on `/sim/*`;
  - authenticated routes only;
  - the quant service is not exposed to the browser;
  - audit on every run;
  - no user text reaches the quant service, only numbers and enums.
- **S10:**
  - the pyramid covers statistics, the kernel against its Python source, routes, the api against a stub quant, and e2e against the real quant;
  - the benchmark is committed and a perf guard runs in CI.
