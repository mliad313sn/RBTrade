# kora-quant

Python FastAPI service for Monte Carlo, backtests and metrics. Goal 01 ships the skeleton: `/health`, decimal helpers and the toolchain. Numpy, pandas and numba arrive in goal 05.

```bash
bash ../../scripts/py-setup.sh   # creates .venv (Python >= 3.11) and installs dev deps
.venv/bin/python -m kora_quant   # http://127.0.0.1:8000/health
bash ../../scripts/py-check.sh   # ruff + mypy --strict + pytest (coverage >= 85%)
```
