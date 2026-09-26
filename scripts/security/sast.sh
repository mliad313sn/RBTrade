#!/usr/bin/env bash
# SAST (goal 10): Semgrep registry rulesets + the repo's own KORA rules (.semgrep.yml).
# Fails on any finding. The two njsscan "good_*" rules report the presence of a control (informational) and are excluded. Reviewed false positives carry an inline `nosemgrep: <rule> -- reason`.
# Needs semgrep on PATH (`pip install semgrep`); CI installs it in the security job.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${SEMGREP_JSON:-}"
args=(scan --metrics off --error --config .semgrep.yml
  --config p/typescript --config p/javascript --config p/python --config p/secrets
  --config p/owasp-top-ten --config p/nodejsscan --config p/github-actions --exclude-rule ajinabraham.njsscan.good.good_helmet_checks.helmet_header_x_powered_by --exclude-rule ajinabraham.njsscan.good.good_helmet_checks.helmet_header_check_csp
  --exclude node_modules --exclude .next --exclude dist --exclude coverage --exclude storybook-static
  --exclude .venv --exclude design --exclude .data)
[ -n "$OUT" ] && args+=(--json -o "$OUT")
semgrep "${args[@]}"
