#!/usr/bin/env bash
# Runs a tool from services/quant/.venv, creating the venv first if needed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/services/quant/.venv"
[ -x "$VENV/bin/python" ] || bash "$ROOT/scripts/py-setup.sh"
tool="$1"; shift
exec "$VENV/bin/$tool" "$@"
