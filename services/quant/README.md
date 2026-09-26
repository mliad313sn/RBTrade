# kora-quant

Python FastAPI service for the gain simulator (goal 05): Monte Carlo projection, block bootstrap, reality checks and paper-account analytics. It uses numpy and numba. Robot research (backtests, goal 06) and the market intelligence scanner (goal 07B) live here too.

```bash
bash ../../scripts/py-setup.sh   # creates .venv (Python >= 3.11) and installs dev deps
.venv/bin/python -m kora_quant   # http://127.0.0.1:8000/health, OpenAPI at /docs
bash ../../scripts/py-check.sh   # ruff + mypy --strict + pytest (coverage >= 85%)
.venv/bin/python bench/bench_mc.py --runs 30 --write bench/RESULTS.md   # performance budget
```

| Route | What |
|---|---|
| `POST /mc/project` | Monte Carlo projection of a parametric edge (costs on by default) |
| `POST /mc/from-trades` | circular moving-block bootstrap of a trade list (R multiples or % returns) |
| `POST /analytics/paper` | equity curve and trade statistics from `Fill[]` (Decimal P&L) |
| `POST /reality-checks` | reality-check rules without a simulation |

The api (`apps/api/src/sim`) is the only intended caller. It validates, rate-limits and audits every run.

Model and formulas: `docs/quant/monte-carlo.md`. Rule rationales: `docs/quant/reality-checks.md`.

`numba` caches compiled kernels next to the sources (`__pycache__`). In containers, `NUMBA_CACHE_DIR` points to a writable directory.

## Market intelligence scanner (goal 07B)

| Route | What |
|---|---|
| `POST /scanner/run` | detectors over the universe (numbers only), emerging-trend labels, regime nowcast, optional walk-forward calibrated forecasts per horizon; look-ahead guard (422 `look_ahead` on failure) |

Package `kora_quant.scanner`: `panel` (instrument-time panel), `kernels` (numba), `detectors`, `guard`,
`incremental` (bar-close state), `forecast` + `calibrate` (walk-forward logistic, isotonic/Platt,
skill after costs, linear SHAP), `synthetic` (SIMULATED benchmark universes). The goal 06 `ai_regime`
condition reads the regime filter when a research request sends `aiRegime: "model"`.

```bash
.venv/bin/python bench/bench_scanner.py --write bench/SCANNER_RESULTS.md   # 10,000 × 500 1h bars < 60 s
```

Design: `docs/adr/0007b-market-intelligence.md`.
