# kora-quant

Python FastAPI service for the gain simulator (goal 05): Monte Carlo projection, block bootstrap, reality checks and paper-account analytics. It uses numpy and numba. Backtests arrive in goal 06.

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
