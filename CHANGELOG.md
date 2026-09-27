# Changelog

All notable changes to KORA. Versions follow [Semantic Versioning](https://semver.org/); commits follow
[Conventional Commits](https://www.conventionalcommits.org/). Generated from git history for 1.0.0-rc.1;
later entries are added per release.

## 1.0.0-rc.1 — 2026-09-27 (release candidate, PAPER only)

`LIVE_TRADING_ENABLED=false`. All market data, news and accounts are SIMULATED. Not for market
launch until the Sponsor launch checklist in `RELEASE_CHECKLIST.md` is complete.

### Highlights by goal

- **01 Foundation:** pnpm/Turborepo monorepo, dev OIDC IdP (Keycloak-ready), TOTP MFA, RBAC, design system, app shell, hash-chained audit log.
- **02 Market data:** global instrument registry (ISO 10383 MICs, calendars, time zones), SIMULATED feed, candles, WebSocket gateway with quotas and conflation.
- **03 OMS and risk:** paper engine, pre-trade risk, idempotent orders, double-entry ledger, reconciliation, three-scope kill switch with REST fallback.
- **04 Pro Terminal:** multi-panel terminal, ticket with full cost/loss preview, hotkeys, colour-blind-safe convention.
- **05 Gain Simulator:** Monte Carlo projections (P5–P95), scenarios, costs on by default.
- **06 Robot Trader:** strategy DSL, backtester with IS/OOS/walk-forward and deflated Sharpe, BullMQ paper runner.
- **07 / 07B AI:** draft-only copilot with grounded tools and evals; market intelligence scanner with calibrated, cited forecasts.
- **08 Novice view:** guard-railed desktop and mobile PWA, onboarding, limits, cooling-off, EN/FR copy.
- **09 Governance:** four-eyes controls, risk console, COBIT control matrix and evidence export, retention, audit anchors, runbooks and SLOs.
- **10 Release readiness:** session revocation, MFA recovery codes, OpenAPI contracts and generated SDK types, cross-service traces, Grafana dashboards and alerts with runbooks, golden-path e2e, axe on every route, chaos drill, load tests with performance fixes, STRIDE threat model, release pipeline with manual approval, rollback and restore drills.

### Features

- feat(observability): traces across api, bot runner and quant; operational metrics, Grafana dashboards and alert rules with runbook links (`bc62b45`)
- feat(security): server-side session revocation, MFA recovery codes (B-902), trusted proxy hops (B-015), fail-closed metrics (`62a521c`)
- feat(web): log an incident from a critical alert on the risk console; fix(sdk): unused import (`5f91d32`)
- feat: backup and restore-test script, tabletop exercise script, TLS transport checks outside dev/test, goal 09 env reference, OpenAPI regenerated (`f739019`)
- feat(web): risk officer console with live alerts, four-eyes approvals and the firm kill switch; internal audit view; evidence export; halted banner four-eyes state; B-801 copy EN/FR (`991b0a3`)
- feat: B-202 minor-unit quotes (GBX pence for HSBA.XLON), registry unit and factor, multiplier in the major currency, unit shown in the ticket (`77f27bc`)
- feat(api): B-203 WebSocket per-user and per-IP quotas, token refresh on an open socket; SDK refresh and risk alerts (`9d28bce`)
- feat(api): governance and compliance modules: control catalogue and evidence export (CSV/PDF), risk console, internal audit, anchors, incidents, suitability, KYC stub, subject access; generated control matrix (`ec12a9f`)
- feat(api): four-eyes resume policy and firm halts, limit overrides, B-801 gate, breach alerts, DB disclosures registry, B-303 audit visibility, auditor SoD (`35aaf18`)
- feat(api): migrations 0090-0091 for four-eyes, limit overrides, alert notify, anchors, incidents, backups and the disclosures registry (`2821c04`)
- feat(domain): auditor role and SoD rule, four-eyes and ITIL incident types, audit sampling, B-801 risk code, risk:alerts channel (`abc05f1`)
- feat(web): Market Radar, trend cards, public reliability page, novice What's moving card, draft loader (`25dd29d`)
- feat(evals): goal 07B cases — news injection and schema, trend explanations, market radar (117/117 scripted) (`319ac76`)
- feat(api): intel module — bar-close scans, forecasts logged before outcomes, news pipeline, trend cards, radar, alerts, reliability (`1a0ab5f`)
- feat(api): gateway structured outputs and market intelligence copilot tools (`2caa99f`)
- feat(api): migrations 0075-0077 for scans, features, trends, forecasts, news and radar alerts (`63fda12`)
- feat(market-data): provider adapter matrix per continent (flagged stubs) and holiday/DST session tests on seeded calendars (`03c2802`)
- feat(quant): market intelligence scanner — detectors, regime filter, look-ahead guard, walk-forward calibrated forecasts, 10k benchmark (`cf27722`)
- feat(web): novice onboarding, home, 3-step trade with review sheet, limits, auto-invest, learn and knowledge check (B-306, B-505, B-017) (`d8083e2`)
- feat(web): localised, 390 px-first novice shell with 44 px targets; Pro shell split into its own chunk (`c319575`)
- feat(web): installable PWA with an offline 'prices paused' shell and the Explain-this slot for goal 07 (`8e44964`)
- feat(web): EN/FR i18n for the Novice view with a CI completeness check and a readability report (B-013) (`77e9bee`)
- feat(infra): Grafana dashboard for copilot tokens, cost and budgets; Prometheus scrapes the api (`efceec6`)
- feat(web): copilot surfaces — terminal AI strip, robots copilot drawer, streaming chat, ExplainThis (`2e6fda0`)
- feat(evals): services/ai-evals — 80 graded copilot cases with deterministic graders (`2a40deb`)
- feat(sdk): typed sim, scenario and novice methods (B-506) (`49e5e7a`)
- feat(api): saved and named simulator scenarios (B-505) (`97cde9e`)
- feat(api): novice view API with ticket, knowledge check, auto-invest (B-614) and TOTP opt-in (B-017) (`82c6916`)
- feat(api): novice guardrails for loosening limits, cooling-off, monthly limit and the borrowing cap (`41708eb`)
- feat(api): novice migrations and a disclosures interface with versioned acknowledgements (`515113e`)
- feat(api): AI gateway module — chat (SSE), explain, strip, why-panel, drafts, calibration, budgets, metrics (`ada4281`)
- feat(api): copilot core — tool catalogue, dispatcher, guards, calibration, engine and providers (`b47b463`)
- feat(api): migration 0070 for AI drafts and the calibration table; Anthropic SDK and prom-client (`1b4ad56`)
- feat(domain): novice ticket, guarded limit changes, cooling-off and template risk levels (`c7cfb35`)
- feat(api): simulator follows venue sessions by default outside dev/test (B-208) (`b72d78e`)
- feat(web): simulator Import from backtest posts the latest backtest's OOS R multiples to /sim/from-trades (B-502) (`987a16d`)
- feat(web): robot builder (drag-and-drop blocks, inline params, validation, JSON view, import/export) and monitor (IS/OOS equity, KPI table, overfitting checks, heatmap, walk-forward, Monte Carlo, risk meters, audit feed, promotion checklist, hold-to-halt-all) (`2128331`)
- feat(web): terminal settings (density, UTC/local, sound on fills, per-trade risk rule) and configurable hotkeys in Settings (`f3c50a6`)
- feat(api): strategies with immutable hashed versions, research runs with server-counted trials, robots via the OMS (B-301 internal service API), supervisor, tracking error and four-eyes promotion (`fd3b975`)
- feat(bot-runner): BullMQ bar-close evaluation via the api internal endpoints and quant, heartbeats, kill-switch reaction and daily tracking job (`3b427ee`)
- feat(sdk): venues() for the registry browser (`d7edeb3`)
- feat(web): dockable pro terminal (watchlists, chart, order book, time and sales, full ticket, streaming blotter, alerts, risk), command palette, hotkeys and AI strip slot (`572e8a0`)
- feat(quant): bar backtester with look-ahead guard, registry cost model, IS/OOS and walk-forward, metrics, deflated Sharpe, capped optimisation, sensitivity heatmap and live signal endpoint (`c8ce7cf`)
- feat(api): terminal module (layouts, watchlists, server-evaluated alerts, risk summary), cancel-all, trades channel, test-only session override; SDK methods and typed socket helpers (`0416ad7`)
- feat(domain): strategy DSL v1 (zod), content hash, templates, builder catalog and robot/research request schemas (`d1343c7`)
- feat(domain): indicator library, terminal ticket maths and schemas, risk analytics, trades channel, terminal settings (`f134747`)
- feat(web): novice-only sign-up with appropriateness page, account figures in the top bar, kill switch results with halted banner and resume, ticket and blotter wired to the paper engine (`223f1e9`)
- feat(sdk): trading, kill switch resume/state and appropriateness methods; OpenAPI regenerated with goal 03 endpoints (`bf1e86d`)
- feat(api): paper analytics from the account's real fills (B-501); kill switch, risk, appropriateness, realtime and integrity integration tests (`3a47288`)
- feat(api): trading core with OMS, paper engine, pre-trade risk, kill switch engine, reconciliation and FX-aware accounts (`2c5a735`)
- feat(domain): trading core types, order state machine, ledger, position, costs, preview, risk rules and questionnaire engine (`18715a6`)
- feat(web): live SIMULATED watchlist on the Pro terminal via the SDK WebSocket client, with stale badge (`0436473`)
- feat(sdk): typed market data WebSocket client with auth, backoff, resubscribe and heartbeat; REST market data methods (`f362a29`)
- feat(web): Pro gain simulator and Novice practice screens (`aaee754`)
- feat(api): market data module with feed service, ref-counted conflating WebSocket gateway, registry, candles, quotes and calendar endpoints (`a42ffec`)
- feat(db): market data migration with global venue registry, trades, 1s bars, hierarchical candle rollup and retention (`b5745ec`)
- feat(market-data): deterministic simulator, adapter interface, flagged venue stubs, bars, conflation and SIMULATED global registry seed (`a4d0766`)
- feat(api): sim module proxying the quant service with zod validation, rate limit and audit (`162e293`)
- feat(quant): Monte Carlo projection, block bootstrap, reality checks and paper analytics (`68f6556`)
- feat(domain): normalised market data schema, channels and venue session status across DST (`f2ff642`)
- feat(infra): quant and bot-runner skeletons, compose reference stack, Keycloak realm, Dockerfiles and CI (`5ba4c4c`)
- feat(web): Next.js app shell with auth flow, route guards, Pro/Novice modes and kill-switch entry (`4a14429`)
- feat(ui): design system with pro-dark/novice-light tokens, primitives, formatters and Storybook (`a8459ab`)
- feat(api): NestJS api with dev OIDC IdP, TOTP MFA, RBAC guards, preferences, kill-switch intent and hash-chained audit log (`923aafd`)

### Fixes

- fix(security): SAST findings fixed or reviewed, supply-chain settings, history secrets scan (`0ae7d72`)
- fix(api): B-014 sign-up answers the same for new and existing e-mails (`8ca3079`)
- fix(api): manual scan without history answers 409 with a plain message; docs: README sections for 07B (`7b81397`)
- fix(api): scripted card summaries strip untrusted wrappers; ATR rounded to instrument precision (`f356255`)
- fix(web): keep novice 44 px targets regardless of stylesheet order (`f1f5301`)
- fix(web): no hydration mismatch on dates, metric-matched font fallbacks (mobile CLS), label-in-name on novice controls (`7373ed4`)
- fix(web): ticket preview never starves while a %/pips stop moves with every tick (`d75ba3c`)
- fix(web): never persist a partial dock layout; update goal 02/03 e2e for the Pro ticket (hold to confirm) and status bar feed state (`07b5d4e`)
- fix(api): backfill every symbol without history, anchored to its earliest live bar or the simulator start (`8c7b91e`)
- fix(deps): upgrade OpenTelemetry SDK and override postcss to clear audit findings (`7124b4f`)

### Performance

- perf(market-data): formatPrice fast path for values already on a unit tick (`41a1291`)
- perf: audit chain head in one round trip, memoised session status, runner concurrency; test(load): open-loop generator (`ae9c8b0`)
- perf(api): load-test harness and first findings; fix(security): revoked sessions cannot open a WebSocket (`a37c0a1`)
- perf(api): pre-framed corked fan-out and token-bucket conflation; WebSocket fan-out load test with results (`5e5ea9e`)

### Tests

- test(chaos): scripted drill killing the feed, Redis, quant and the AI provider; fix(api): market data cache answers no value while Redis is down (`79c6387`)
- test(e2e): golden paths (robot paper-run to kill switch, definition-of-done audit trail), axe on every route, keyboard walkthrough, colour convention; fix(ui): dialogs return focus to their opener (`45435fc`)
- test(contracts): OpenAPI response contracts, SDK types generated and checked, service contract proxies; fix(quant): unbounded Kelly as null (`f9e9559`)
- test(api): goal 09 integration tests for four-eyes, evidence export, risk console, internal audit and compliance; novice tests acknowledge the risk warning (`1f85364`)
- test(web): radar e2e drafts on ETHUSD and leaves other specs' candle history alone (`4569037`)
- test(e2e): wait for the kill switch to hydrate before pressing it (`f7aa9e6`)
- test(api): model-id guard matches id prefixes only (`52fba42`)
- test(web): novice acceptance flow, 390 px mobile and PWA e2e; onboard novices in the sign-in helper (`2846b0e`)
- test(api): novice guardrails, 20-case ticket parity, onboarding and auto-invest (`50f14b9`)
- test: trades channel is now valid in the gateway test; lint-clean e2e output (`39a554e`)
- test: tracking-error integration test on now-relative bars (end-of-data trades are not realised); shared QueueEvents in runner tests (`8ae3170`)
- test(e2e): Trend-X flow from blocks to audit trail, simulator import, axe on builder and monitor; bot runner in the e2e stack with overridable ports and Redis namespace (`ac441a9`)
- test(web): unit tests for hotkeys, layout validation, frame-batched market store, registry search, view models and 500-row virtualisation (`b55b2ff`)
- test(web): visual regression at 1440x900 (own baseline, structural and perceptual comparison with the prototype) and the 1280 px breakpoint; sticky ticket submit (`d0a210a`)
- test(web): goal 04 acceptance e2e (EUR/USD ticket to fill, kill switch, layouts, watchlists, axe, contrast, tick-to-paint, CLS, keyboard-only); order book listbox, stable layout (`b510845`)
- test(api): robots config and service-token guard unit tests; supervisor interval defaults to 1 s when unset (`ad5a478`)
- test(api): strategies/backtests, bot-runner parity, crash auto-pause, kill switch within 1 s, heartbeat loss and promotion RBAC integration tests (`a737243`)
- test(api): trading unit tests (config, DAY expiry across sessions, broker adapters, float scan) and risk timing measurement; cache period-start equity (`585c69a`)
- test(api): OMS and paper engine integration tests (idempotency x50, partial fills, IOC/FOK, gapped stop, bracket, OCO, trailing, expiry, ledger) and preview fixtures (`ce46a41`)
- test(api): market data integration tests for registry drift, hand-computed candles and p95, feed kill/restart resync, stall staleness and gateway behaviour (`d5ef02c`)
- test(e2e): simulator and practice flows; start the quant service for e2e (`dafca5c`)
- test(ui): run axe on every Storybook story in Chromium for both themes (`746fadb`)

### Documentation

- docs(security): STRIDE threat model and scan evidence; test(e2e): web security headers (`a2fbaac`)
- docs: plan 10 QA, security hardening, observability and release (`f4334ac`)
- docs: plan 09 e2e latency from the full run (`6e952e3`)
- docs: goal 09 results in plan 09, STATUS G9 row and section, backlog B-901..B-916 and 09 item statuses, README section (`0839b54`)
- docs: runbooks for six scenarios, SLOs, ITIL 4 incident workflow and review template, tabletop record with evidence; data protection and three lines; ADR 0009; open questions with owners and a register test (`9650362`)
- docs: plan 09 risk, compliance and governance (`d5c7a7f`)
- docs: goal 07B results in plan 07B, STATUS G7B row and section, backlog B-751..B-761, open questions OQ-A4/OQ-M6 (`e35d3e2`)
- docs: ADR 0007B market intelligence with threat model additions (`52b287c`)
- docs(sdk): regenerate OpenAPI with the goal 07B /intel endpoints (`c1a00d4`)
- docs: goal 08 results and STATUS (`5c5f4a6`)
- docs(adr): 0008 novice view (`5e04591`)
- docs: goal 08 env reference, README section, copy-review pack (B-504), open questions OQ-N1..N4, backlog B-801+ (`e4b8035`)
- docs: plan 07B market intelligence (scanner, forecasts, news, radar) (`0b3c276`)
- docs: goal 07 results in plan 07, STATUS G7 row and section, backlog B-701..B-708, open questions OQ-A2/OQ-A3, README section (`fbd9b2f`)
- docs: ADR 0007 AI copilot with the threat model (`931a316`)
- docs(sdk): regenerate OpenAPI with the goal 07 /ai endpoints (`e46a897`)
- docs: plan for goal 08 novice view (`f86e602`)
- docs: plan 07 AI copilot (gateway, tools, calibration, safety, evals) (`50ad1f3`)
- docs: goal 04 results in the plan, STATUS G4 and hand-over, backlog B-401..B-410 and retargets (`56beefe`)
- docs: ADR 0004 pro terminal, README section and env reference for goal 04 (`3b31c8c`)
- docs: goal 06 results in plan 06, STATUS goal 06 section and G6 row (`d41f986`)
- docs: ADR 0006, backtester reference, README robot section, backlog B-601..B-614 and open questions (`e30f455`)
- docs(sdk): regenerate OpenAPI with the goal 06 strategy, research, robot, review, signal and internal endpoints (`666e3d7`)
- docs(plan): goal 06 robot trader plan (`d2ad142`)
- docs(plan): goal 04 pro terminal plan (`02a84fe`)
- docs: goal 03 results, ADR 0003, STATUS G3, backlog B-301..B-315 and open questions (`6da05b0`)
- docs: README trading section and goal 03 env reference; empty appropriateness overrides fall back to the reviewed data (`a5e8915`)
- docs(plan): goal 03 OMS, paper engine, risk, kill switch and appropriateness plan (`8f8d642`)
- docs(plan): final goal 02 verification numbers (`62bb97c`)
- docs: goal 02 results, ADR 0002, STATUS, backlog, open questions and env reference for market data (`8007a6d`)
- docs(sdk): regenerate OpenAPI with market data endpoints (`bb9a5d6`)
- docs: goal 05 ADR, plan results, status, backlog and open questions (`d98a5ad`)
- docs(plan): goal 02 market data plan with global venue registry (`d115aea`)
- docs(goal): add goal 07B market intelligence and global-coverage scope amendment (`4765e3d`)
- docs(plan): goal 05 gain simulator plan (`ad91e51`)
- docs(governance): record sponsor decisions on buy-button contrast and trader appropriateness (`329f95a`)
- docs(status): correct migrate --all invocation (`cf58253`)
- docs(plan): goal 01 verification results, status, backlog and README (`1e96ed7`)
- docs(plan): add master plan, dev-environment and stack ADRs (G0) (`7304ebb`)

### Build

- build: scaffold pnpm + turborepo monorepo with shared configs and domain package (`daf9fa1`)

### Chores

- chore: goal 07B env reference (scans, horizons, news, ai_regime, flagged news stubs); empty intel flags mean the default (`4842b4a`)
- chore: goal 07 env reference (provider, budgets, cache, calibration, prices, metrics token) (`7c293f8`)
- chore: goal 06 env reference and dev service-token generation (`3e22444`)
- chore(market-data): lint-clean load scripts, publisher-only mode for k6, test timeout headroom (`a9125b0`)
- chore: ignore agent worktrees (`06e5151`)
- chore: bootstrap KORA governance, goal pack and prototype references (`126b5d5`)

### Style

- style(api): prettier formatting for the sim module (`2db0180`)
