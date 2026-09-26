# /goal 10 — QA, security hardening, observability and release readiness

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, all ADRs and plans.

## Goal
Take KORA from "feature complete" to "release candidate" with end-to-end quality, security and operability evidence. Fix what this finds, and don't add new features.

## Scope
1. **Test pyramid audit:** measure coverage per package and raise domain logic to ≥ 85%. Add missing contract tests between web ↔ api ↔ quant ↔ bot-runner, generated from OpenAPI.
2. **Golden-path e2e suite (Playwright, runs in CI against docker compose):**
   - Pro trade lifecycle;
   - Simulator scenarios;
   - Robot build → backtest → paper-run → kill switch;
   - Copilot explain + draft;
   - Novice onboarding → trade → limit → cooling-off;
   - risk officer approval;
   - audit verification.
3. **Chaos and resilience tests:** kill the market-data adapter, Redis, the quant service and the AI provider, one at a time. Expected behaviour:
   - graceful degradation;
   - stale badges;
   - the kill switch still works via REST;
   - no orders sent on stale data;
   - recovery without duplicated orders.
4. **Load tests (k6):**
   - 500 concurrent terminal users;
   - 200 symbols streaming;
   - 50 bots on 1m bars;
   - order burst of 100 orders/s.

   Record p50/p95/p99 and error rates against the targets from goals 02–03.
5. **Security:**
   - threat model (STRIDE) for auth, orders, AI and admin;
   - SAST (Semgrep) and dependency and image scanning with no high or critical findings;
   - DAST (OWASP ZAP baseline) on staging;
   - authz matrix tests for every endpoint × role;
   - rate limits;
   - CSRF, CSP and security headers;
   - secrets scan of git history;
   - session and MFA hardening.
6. **Observability:**
   - OpenTelemetry traces across services, with an order traced from ticket to fill;
   - Grafana dashboards: feed health, order latency, rejection reasons, fills/slippage, bot heartbeats, AI tokens/cost, error budgets;
   - alert rules mapped to runbooks from goal 09.
7. **Accessibility and UX audit:** WCAG 2.2 AA pass on all routes, keyboard-only walkthrough, screen-reader spot checks, and colour-convention settings verified.
8. **Release:**
   - versioning and a CHANGELOG;
   - staging deploy pipeline with manual approval;
   - database migration rollback tested;
   - backup/restore drill;
   - a `RELEASE_CHECKLIST.md` including confirmation that `LIVE_TRADING_ENABLED=false` and all regulatory placeholders are either resolved or explicitly accepted by the owner.

## Acceptance criteria
- [ ] All CI stages are green: lint, types, unit, contract, e2e, AI evals, security scans and a11y.
- [ ] Load-test results meet the targets or have an owner-accepted exception recorded.
- [ ] Every chaos scenario behaves as specified, with evidence (logs and screenshots) in `docs/qa/`.
- [ ] There are 0 open critical or high vulnerabilities, and the threat model is committed.
- [ ] Traces show the full order path, and each alert links to its runbook.
- [ ] `docs/STATUS.md` is marked **RC-1**, with known limitations and next steps listed.
