# /goal 05 — Gain Simulator: Monte Carlo projection and paper-account analytics

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, `/design/prototype/Simulator.dc.html`.

## Goal
Build an **honest** gain simulator. It projects the distribution of outcomes for a trading edge, with costs included by default, stress-tests it and flags unrealistic assumptions. It runs in the Python quant service and is used by Pro, by Robots ("Send to Monte Carlo") and in a simplified form by Novice ("Practice").

## Scope
1. **Quant service (`services/quant`, FastAPI):**
   - `POST /mc/project`, with inputs: capital, sizing model (fixed-fractional % | fixed amount | Kelly fraction), risk %, win rate, avg win/loss (R), cost per trade (R), trades per period, horizon, ruin floor %, fat-tail probability and multiple, stress edge-cut %, withdrawals schedule, seed and paths (default 10,000, max 50,000).
   - `POST /mc/from-trades`: block-bootstrap resampling of an actual trade list (from a backtest or the paper account), with block size auto-chosen or user-set.
   - Outputs:
     - percentile bands (P5/P25/P50/P75/P95) per period;
     - final equity distribution;
     - P(ending below start) and risk of ruin;
     - max-drawdown distribution (median, P95, histogram);
     - time under water;
     - longest losing streak;
     - expectancy after costs;
     - full-Kelly and the user/Kelly ratio;
     - 3 sample paths.
   - Implemented with numpy and numba. 10k paths × 1,000 trades must finish in < 1.5 s, and results are cached by input hash.
2. **Reality-check engine:** pure rules that return warnings with severity:
   - implausible edge (e.g. win ≥ 60% with R ≥ 2);
   - risk > 2% per trade;
   - no edge after costs;
   - sizing above full Kelly;
   - sample size < 100 trades when importing;
   - in-sample source (warn to use out-of-sample).

   Each rule has a documented rationale in `docs/quant/reality-checks.md`.
3. **Paper-account analytics:** from goal 03 fills, compute the realised equity curve, drawdown, win rate, profit factor, expectancy, cost drag and exposure. "Project from my paper results" calls `/mc/from-trades`.
4. **UI (Pro):**
   - assumptions panel with sliders and number inputs;
   - fan chart (P5–P95 and P25–P75 bands, median, start and ruin-floor lines, sample paths) with a SIMULATED watermark;
   - 5 KPI tiles, drawdown histogram, risk table and a reality-checks list;
   - stress and fat-tail toggles;
   - "Import from backtest" (goal 06) and "Import from paper account";
   - scenario compare (A/B overlay of two runs);
   - export as CSV or PNG.
5. **UI (Novice / Practice):** three plain-language inputs (how much, how often, how careful) mapped to parameters. It shows "good year / typical year / bad year" as three numbers plus a simple band chart and the explicit sentence "This is a simulation, not a promise".
6. The API validates inputs (e.g. win 1–99%), rejects silly values with explanations, and rate-limits requests.

## Acceptance criteria
- [ ] Statistical tests:
  - with zero costs and a known edge, the MC mean final equity matches the analytic expectation within a 1% tolerance at 50k paths;
  - risk of ruin matches the closed-form approximation for fixed-fractional sizing on test cases;
  - the same seed gives identical output.
- [ ] Performance: 10k paths × 1,000 trades in < 1.5 s p95 (benchmark committed).
- [ ] Every reality-check rule fires and doesn't fire on the right fixtures.
- [ ] The e2e flow sets assumptions → projects → toggles stress (the median must drop) → imports the paper account → compares scenarios → exports CSV.
- [ ] The Novice Practice screen passes a plain-language review. Jargon terms are either glossary-linked or absent.
- [ ] The STATUS update is done.
