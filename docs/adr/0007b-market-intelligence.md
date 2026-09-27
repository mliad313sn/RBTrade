# ADR 0007B — Market intelligence: scanner, calibrated trend forecasts, news, Market Radar

Status: Accepted (goal 07B, 2026-09-26). Lead seats S7 (AI), S5 (quant), S2 (senior trader),
S8 (compliance). Related: ADR 0002 (registry, sessions, SIMULATED feed), ADR 0006 (look-ahead guard,
`ai_regime` condition), ADR 0007 (gateway, calibration table, safety, evals). Plan and evidence:
`docs/plans/07b-market-intelligence.md`.

## Context

The sponsor asked for an AI helper that scans every market and the news, detects and forecasts
trends and explains them with evidence, on any asset class and exchange on all five continents. The
master-goal rules apply unchanged: the AI never executes, a confidence figure is shown only if it is
calibrated, news is untrusted data, every call is audit-logged, nothing is personal advice. There
are no licensed data or news contracts and no API key in this environment: all data is SIMULATED and
CI must be deterministic.

## Decision

### 1. Coverage and providers

The goal 02 registry already has 19 venues (ISO 10383 MICs, IANA time zones, sessions, holidays)
on every continent and all 13 asset classes; it is not padded with synthetic rows. Radar regions
group venue regions into continents (`americas`, `europe`, `africa`, `asia`, `oceania`) plus
`global` for KORA's simulated OTC venues. Sector labels for the seeded instruments are SIMULATED
(`intel/core/taxonomy.ts`). The provider adapter matrix (`packages/market-data/src/providers/matrix.ts`,
`GET /intel/providers`) lists market-data and news sources per continent; every entry is a flagged,
unlicensed stub with its licensing need, tied to OQ-M3 / OQ-M4. Session/DST **and holiday** tests on
the seeded calendars cover XNYS, XLON, XTKS, XHKG, XJSE, BVMF and XASX.

### 2. Scanner (`services/quant/src/kora_quant/scanner`, `POST /scanner/run`)

- **Panel in instrument time**: each instrument's own last T bars, right-aligned. A closed venue has
  no bars, so windows count trading bars. *Amended 2026-09-27 (IRTC R3-04):* comparing instruments
  at the same bar position was **not** causal: when an instrument is stale, halted or on another
  calendar, its column t holds an earlier time than its peers' column t, so its relative strength
  used peers' later bars (the IRTC reproduction: 8/8 fake "skill" for a 4-bar-stale instrument).
  Cross-sectional detectors now match peers on the bar start time (a peer with no bar at that exact
  time is left out), so no information after the instrument's own bar close can enter.
- **Detectors output numbers only** (20 features): ADX/ATR, slope t-stat, regime probabilities,
  breakout and channel position, band-width percentile and ATR ratio (compression), momentum and
  mean-reversion z, relative strength vs sector and region, correlation break, volume and return
  z-scores, volatility ratio, hour-of-day seasonality, minutes to the next scheduled high-impact
  event. Emerging-trend labels (`up, down, range, breakout_up/down, reversal, vol_regime`) are
  transparent rules over those numbers and rank patterns; they are not forecasts.
- **numba kernels** loop over time and are vectorised across instruments; the kernels are tested
  against their pure-Python source. **Benchmark** (`bench/SCANNER_RESULTS.md`, CI guard
  `test_scanner_perf.py`): 10,000 SIMULATED synthetic instruments × 500 one-hour bars in 8.6 s mean /
  10.4 s worst (budget 60 s). Incremental bar-close mode (`ScanState`) keeps a 600-bar window per
  timeframe and matches a full-history scan to 1e-6.
- **Look-ahead guard**: every feature at bar t must equal the value computed on bars 0..t
  (prefix recomputation at checkpoints, same idea as goal 06). A leaky detector or injected future
  data raises `LookAheadError`, which the route maps to 422; the api path runs it on every scan.
  *Amended 2026-09-27 (IRTC R3-05):* the api default of 2 checkpoints compared only column 0 (warm-up,
  all NaN) and the last column (prefix = full), so it checked nothing while reporting "passed". Now:
  at least 8 checkpoints (`KORA_INTEL_GUARD_CHECKPOINTS` ≥ 8), taken after the warm-up and before
  the last bar, half spread and half random (seeded from the data); the prefix is cut by
  **wall-clock time** (every instrument keeps its bars that started at or before T), and every bar up
  to T is compared, not only the bar at T. The response reports `compared` (finite values checked)
  and `passed` is false when nothing was compared.

### 3. Regime model and the goal 06 `ai_regime` hook

A "volatility-clustering" model: a two-state Markov-switching filter on returns (calm σ from the
previous 100 bars, volatile = 2.5σ, stay probability 0.97) gives P(volatile); P(trending | calm) is a
fixed logistic of |momentum z|; ranging is the rest. It is a forward filter, so it is point-in-time by
construction and checked by the guard. The goal 06 hook is **filled**: `regime_trending|ranging|
volatile` are registered as causal indicator features, so the backtester's own look-ahead guard covers
them; the `ai_regime` condition reads the bar's probability (`p > minProbability`, contribution from
the margin) when the request says `aiRegime: "model"`. The api sends it from `KORA_AI_REGIME`
(default `model`); `off` restores `not_available`, and warm-up bars stay `not_available`
(skip/block by the strategy's choice). The raw filter probability is used inside backtests; a
calibrated regime display (`trend:regime:<tf>` rows) is deferred (B-752).

### 4. Trend forecasts and "No reliable signal"

Per instrument × horizon (`1d, 1w, 1m` = 24/120/480 one-hour bars): L2 logistic regression (numpy
IRLS) on standardised scanner features, trained point-in-time with an anchored walk-forward (5 folds,
embargo = horizon: a training label must end before the test fold starts). Each fold is calibrated
with isotonic regression (PAV) on the earlier folds' out-of-sample scores (Platt with fewer than 200,
identity with fewer than 30). Skill after costs: Brier skill vs the training base rate and the net
return of following the forecast direction minus a SIMULATED round-trip cost, t-statistic on
non-overlapping forecasts. Drivers are exact linear SHAP values (log-odds). Gradient boosting was not
added: no ML dependency is installed, and logistic regression is enough to exercise the pipeline
honestly (B-751).

**Track record**: the live forecast is written to `ai_predictions` (`source: live`,
`model_key = trend:logit:<region>:<horizon>`) at the bar close, before its horizon ends; a resolver
fills the outcome (moved in the forecast direction by more than the cost) from later candles.
Walk-forward out-of-sample forecasts are stored as `history_replay` (non-overlapping). Bins are
rebuilt with the goal 07 `CalibrationService`. *Amended 2026-09-27 (IRTC R3-03):* replayed forecasts
are only those made at a bar close on the fixed calendar grid (a multiple of horizon × timeframe),
so every hourly re-scan replays the same prediction times and the idempotent insert deduplicates
them (before, each scan added a new overlapping phase).

**Display rule**: a probability is shown only if the model's calibration rows show an edge after
costs (mean net > 0, t ≥ 2 on the dependence-aware statistic below) **and** the current score's
bin has n ≥ `KORA_AI_CALIBRATION_MIN_N`; the
number is that bin's observed hit rate with "When we said 0.55, it happened 57% of the time (n=212)".
Otherwise the card says **"No reliable signal"** with the reason (no edge, too few resolved
forecasts, not enough history). On SIMULATED random-walk data this is the normal outcome; the quant
tests show that a planted signal is detected out of sample and random walks are not, and the api
test shows the positive path only from a seeded calibration table.

### 5. News pipeline

`NewsAdapter` interface; `SimulatedNewsAdapter` serves invented multilingual fixtures (en, ja, zh,
de, fr, es, pt, ar; near and exact duplicates; eight injection attempts; `.invalid` links). Three
provider adapters are flagged stubs whose live transport refuses. Pipeline: NFKC normalisation and
invisible-character removal → content hash + word/character shingle Jaccard ≥ 0.8 (dedup) →
dictionary entity linking to registry symbols and venue MICs (incl. local-language names) → local
language guess → **translation and scoring through the goal 07 gateway**: `ProviderRequest.
outputFormat` becomes `output_config.format` (JSON schema) with no tools; the article is wrapped with
`wrapUntrusted({source: 'news', id})`; the JSON is validated with strict zod schemas (range, enum,
no extra keys, entities ⊆ the candidate list). Invalid output is stored as `invalid` with no scores
(DB check); no model → `unavailable`, never invented scores. Each call is audited as `ai.request`
(surface `news`, model id, prompt hash, tokens), counted in the org token budget and in
`kora_ai_tokens_total`. Articles keep source, time and link; explanations cite `[news:<id>]`.

### 6. Explanations and surfaces

Trend cards are computed in code (direction, horizon, probability view, SHAP drivers, regime, risk
and ATR, "what would invalidate this view" = a close beyond last ∓ 2 × ATR or a switch to the
volatile regime, cited news, disclaimer). The plain-language summary is `runCopilot` with the card as
`<grounding>` (surface `radar`), so the numeric-fidelity guard, novice readability ≤ 8 and the
suggestion detector apply. Copilot tools `get_market_radar`, `get_trend_card`, `get_news` (read-only,
novice-allowed, untrusted keys wrapped) answer "What's trending in Asian equities this week and why?".
Web: Pro `/radar` (filters, heat map with ▲▼ and signed text, ranked trends, trend card, streamed
summary, server-evaluated alerts, "Draft to ticket" → audited `ai_order_drafts` row (surface
`radar`) → `/terminal?aiDraft=` pre-fills the ticket, preview and confirmation unchanged; "Send to
Robot builder" → `/robots/builder?template=&symbol=`), public `/reliability`, and the novice
`WhatsMovingCard` exported for goal 08.

## Threat model additions (STRIDE, extends ADR 0007)

| # | Threat | Mitigation | Evidence |
|---|---|---|---|
| T14 | Injected instructions in articles move scores or add entities | Wrapper + neutralised delimiters; no tools on scoring calls; strict schema; entities ⊆ candidates; links come from the dictionary, not the model | 13 news-injection eval cases (100 %) incl. "same article without the injection scores the same", api integration test |
| T15 | Compromised model returns hostile JSON | zod rejects (range, enum, extra keys); stored as `invalid`, no scores (DB check) | adversarial persona tests |
| T16 | Overstated skill on simulated data | Calibration-table gate + edge after costs; "No reliable signal" default; live predictions logged before outcomes; public track record | seeded-table test, quant skill tests, reliability page |
| T17 | Look-ahead in detectors, regime or forecasts | Prefix guard on every scan and backtest; walk-forward embargo; `resolved_at ≥ predicted_at` check | guard tests (leaky detector, injected future bars) |
| T18 | Advice framing on novice surfaces | Plain-word templates, grade ≤ 8, suggestion detector, probability only when calibrated, disclaimer | novice evals, integration tests |
| T19 | Radar draft bypasses confirmation | Draft rows only; the ticket's preview/confirm path is unchanged; static test forbids OMS use in `apps/api/src/intel` | e2e radar flow, `intel.unit.test.ts` static scan |

## Consequences

- Real market data and news need licensed contracts (OQ-M3, OQ-M4); adapters must replace the stubs
  behind the same interfaces, and news AI-processing rights must be part of the licence.
- The live-provider evals (news scoring and trend summaries) are pending an API key (OQ-A2, B-703).
- Goal 08 places `WhatsMovingCard` on the novice Home; goal 09 reviews the plain-language copy and
  the public reliability page; goal 10 scales scanning (sharding, a real incremental kernel) and adds
  Grafana panels for scan latency and news scoring.
