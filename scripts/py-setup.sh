#!/usr/bin/env bash
# Creates services/quant/.venv and installs the quant service with dev extras.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/services/quant"
PY="${PYTHON:-python3}"
if command -v uv >/dev/null 2>&1; then
  uv venv --quiet --python "$PY" .venv
  uv pip install --quiet --python .venv/bin/python -e '.[dev]'
else
  "$PY" -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -e '.[dev]'
fi
echo "[py-setup] $(.venv/bin/python --version) ready in services/quant/.venv"
