Always read docs/goal/00-MASTER-GOAL.md before any work.

Also read docs/governance/CHARTER.md (roles, decision rights, gates) and docs/STATUS.md.

Environment notes for this repo's cloud sessions (see docs/adr/0000-dev-environment.md):
- No Docker daemon. Native PostgreSQL 16 (/usr/lib/postgresql/16/bin) and Redis 7 are available; use them for dev/test.
- docker-compose files stay the reference for real deployments but must not be required to run tests.
- Python 3.11 is installed (master goal says 3.12; code must run on both).
- Never enable LIVE trading. Never hard-code AI model IDs (read KORA_AI_MODEL).
