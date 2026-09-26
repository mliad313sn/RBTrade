#!/usr/bin/env bash
# ruff (lint + format check), mypy --strict and pytest for services/quant.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/services/quant"
[ -x .venv/bin/python ] || bash "$ROOT/scripts/py-setup.sh"
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/mypy
.venv/bin/pytest
