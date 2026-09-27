# Security scans — RC-1 evidence (goal 10)

Run on 2026-09-27 on branch `claude/magical-newton-yyxga6`. CI runs the same commands in the
`security` and `python` jobs of `.github/workflows/ci.yml`; the release pipeline repeats them before
building images.

| Scan | Command | Result | Gate |
|---|---|---|---|
| SAST (Semgrep 422 rules: repo `.semgrep.yml` + p/typescript, p/javascript, p/python, p/secrets, p/owasp-top-ten, p/nodejsscan, p/github-actions) | `bash scripts/security/sast.sh` | **0 findings** over 841 files. 6 scanner notes are parse timeouts/partial parses (Ticket.tsx, dsl.ts, sdk index, portfolio page, ci.yml line 165), not findings. Reviewed false positives carry inline `nosemgrep: <rule> -- reason` | any finding fails |
| npm dependencies | `pnpm audit` | **0 critical, 0 high**, 3 moderate — all `vitest`/`@vitest/mocker` (dev-only test runner, path traversal via redirect mocks; not shipped). `pnpm audit --prod`: 0 | `pnpm audit --prod --audit-level high` |
| Python dependencies | `pip-audit` over the quant venv (48 packages, editable package skipped) | **No known vulnerabilities** | any vulnerability fails |
| Secrets in git history | `python scripts/security/secrets-history.py` (detect-secrets default plugins + regexes for PEM keys, private JWK `d`, vendor tokens, DB URL passwords over **every blob in every ref**) | 1,599 blobs, 204 findings, **204 reviewed / 0 unreviewed**. Every reviewed entry is a dev-only or test value, listed by fingerprint only in `docs/security/secrets-allowlist.json` | any unreviewed finding fails |
| Container images (Trivy) | CI `security` job | **Not run here** (no Docker daemon); runs in CI and the release pipeline | high/critical fails |
| DAST (OWASP ZAP baseline) | `release.yml` job `zap-baseline` against staging | **Deferred to staging**, owner S9 (ZAP cannot be installed here and there is no staging) | high fails |

Moderate advisory follow-up: upgrade `vitest` to ≥ 4.1.11 when it clears the 7-day
`minimumReleaseAge` window and the suite passes on it (B-1011, owner S10).
