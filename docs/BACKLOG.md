# Backlog

Ordered by the Product Owner. Anything found at a gate lands here and is scheduled before goal 10.

| ID | Item | Source | Target goal | Status |
|---|---|---|---|---|
| B-001 | Keycloak end-to-end in CI (compose up, realm import, conditional OTP by role, BFF code flow `/auth/oidc/*`) | G1 deferred | 10 | Open |
| B-002 | Refresh tokens and server-side session revocation (logout everywhere) | ADR 0101 | 09 | Open |
| B-003 | MFA recovery codes and a TOTP reset flow with four-eyes | ADR 0101 / OQ-S1 | 09 | Open |
| B-004 | Generate `packages/sdk` from OpenAPI (`openapi-typescript`), contract tests | ADR 0001 | 10 | Open (goal 04 regenerated `openapi.json` and added typed terminal methods; generation needs response schemas on every endpoint, see B-312) |
| B-005 | WebSocket gateway, plus kill switch REST fallback wired to the engine | goal 01 scope | 02/03 | Done (goal 02 gateway; goal 03 engine behind the same REST contract) |
| B-006 | Audit chain throughput: per-partition chains + global checkpoints if kill switch load shows contention | ADR 0102 | 10 | Checked in goal 03: `recordMany` (one lock, one insert) audits 1,000+ child events in the 178 ms kill switch; no contention. Revisit under multi-account load in goal 10 |
| B-007 | Anchor the audit head hash externally (WORM / signed daily digest) | ADR 0102 | 09 | Open |
| B-008 | Trivy image scan and container hardening verified in CI (no Docker locally) | G1 deferred | 10 | Open |
| B-009 | Command palette (⌘K) actions; goal 01 ships the shell entry point only | goal 01 | 04 | Done (goal 04: registry search grouped by region/asset class with MIC and session, screens, layouts, alerts, display settings, hotkeys) |
| B-010 | Toolchain major upgrades (TS 7, Next 16, Nest 12, vitest 5, ESLint 10, Storybook 10) | ADR 0001 | 10 | Open |
| B-011 | Visual regression vs prototype at 1440×900 | goal 04 | 04 | Done (own baseline + structural/perceptual comparison with `Main.png`, plan 04 §6.3) |
| B-012 | Grafana dashboards beyond provisioning stub; alert → runbook links | goal 01 infra | 10 | Open |
| B-013 | FR translations (EN only in goal 01) | goal 08 | 08 | Open |
| B-014 | Sign-up returns 409 for an existing email (account enumeration). Move to a verify-email flow with a generic response. | G1 S9 review | 09 | Open |
| B-015 | Deployment edge proxy must set a trusted `X-Forwarded-For`. The web `/api` proxy forwards only the nearest hop. | G1 S9 review | 10 | Open |
| B-016 | Instrument registry (goal 02) must feed `Price`/`NumberInput` precision. The goal 01 UI uses explicit precisions only in stories and the ticket skeleton. | G1 | 02 | Open |
| B-017 | The optional TOTP opt-in for novice accounts (API supports MFA for any user once enrolled) needs a settings UI | G1 | 08 | Open |
| B-018 | Remove self-service `trader` at sign-up (OQ-S2 decision). Sign-up creates `novice` only; `POST /appropriateness` assessment (versioned questions, pass mark, cool-down on fail, audit event) upgrades the role to `trader` and requires TOTP enrolment on the next login. API tests and e2e required. | Sponsor decision | 03 (gate), 08/09 (questionnaire engine) | Done in goal 03 (ADR 0003 §9); content review is OQ-C1 / B-313 |
| B-201 | TimescaleDB: hypertables for `md_trades`/`md_bars_1s`, continuous aggregates replacing `md_refresh_candles`, compression and retention policies; exercise the guarded DDL in a Timescale CI job | ADR 0002 | 10 | Open |
| B-202 | Minor-unit quotes (GBX, ZAc) and price multipliers in the registry; LSE/JSE instruments currently quoted in major units | G2 | 09 | Open (not cheap in goal 04: registry columns + engine multiplier, owned by goal 03 code) |
| B-203 | WebSocket: per-user and per-IP connection quotas, token refresh over an open socket (today the socket closes at token expiry) | G2 S9 review | 09 | Open |
| B-204 | Licensed reference data: authoritative venue calendars and holidays, tick-size tables by price band (TSE, HKEX, Xetra), FIGIs, corporate actions (OQ-M2) | G2 | 09 | Open |
| B-205 | Real provider transports behind the stub decoders (after OQ-B1/B2), secrets from vault, recorded fixtures replacing hand-crafted ones | G2 | post-RC | Open |
| B-206 | Simulator CPU: Decimal-heavy step (~0.3 ms per instrument step under coverage); integer tick maths if one feed process must simulate > 200 symbols | G2 | 10 | Open |
| B-207 | Gateway scale-out: load-test 2+ api replicas behind a load balancer (Redis fans out to each) and run the committed k6 scenario in CI | G2 | 10 | Open |
| B-208 | Session-aware UX: "market closed" badge from `session` (not "stale"), and `KORA_MD_RESPECT_SESSIONS=true` as the default outside dev | G2 | 04 | Done (goal 04: MIC + session badges, Closed vs Stale; unset `KORA_MD_RESPECT_SESSIONS` = on outside dev/test) |
| B-209 | OpenAPI response schemas for the market data endpoints, then SDK generation (B-004) | G2 | 03 | Open |
| B-210 | `trades:{symbol}` WebSocket channel (time and sales) and the chart / order book / calendar panels | G2 | 04 | Done (goal 04: batched prints per 250 ms, Time & sales, chart, order book and calendar panels) |
| B-501 | Replace the SIMULATED paper fixture in `apps/api/src/sim/paper-fixture.ts` with the account's real paper fills from the goal 03 engine (same `Fill[]` contract into `/analytics/paper`); add contract multipliers from the instrument registry | goal 05 | 03 | Done (fixture kept, labelled, only for accounts with no fills) |
| B-502 | "Import from backtest" / Robots "Send to Monte Carlo": post the goal 06 trade list (R multiples, `source` IS/OOS) to `/sim/from-trades`; enable the button | goal 05 | 06 | Done in goal 06 (monitor button + simulator import of the latest or `?backtest=` run) |
| B-503 | Shared simulation result cache (Redis, keyed by the same input hash) if the quant service scales beyond one process | ADR 0005 | 10 | Open |
| B-504 | Human plain-language review of the Novice Practice copy (S1 + S8), including FR once B-013 lands; the automated jargon scan is in place | goal 05 | 08 | Open |
| B-505 | Save and name scenarios per user (A/B compare is in-session only today) | goal 05 | 08 | Open |
| B-506 | Regenerate `packages/sdk/openapi.json` after merging goals 02 and 05, and add typed `/sim/*` methods to the SDK (the web uses `apps/web/src/lib/sim/client.ts` meanwhile) | goal 05 | 08 | Partly done: `openapi.json` regenerated in goal 03; typed `/sim/*` SDK methods still open |
| B-507 | OpenTelemetry spans in the quant service (FastAPI instrumentation, trace context from the api); today it has structured logs with the input hash only | goal 05 | 10 | Open |
| B-301 | Bot runner: subscribe to `kora:ctl:robots` (halt/resume), submit robot orders through `OmsService.submit` (`actor.type='robot'`, `source='robot:{id}'`) with service authentication and robot ownership checks; REST `source=robot:*` stays refused until then | goal 03 | 06 | Done in goal 06 (ADR 0006 §6: `/internal/robots/*` with `KORA_SERVICE_TOKEN`, robot → owner → account resolved server-side) |
| B-302 | Matching loop scale-out: advisory-lock leader or per-account sharding across api replicas; move the loop to its own process | goal 03 | 10 | Open |
| B-303 | Audit visibility: let owners read system-actor events about their own orders/accounts (engine fills, triggers, swaps) through `/audit` (today only risk officers/admins see them) | goal 03 | 09 | Open |
| B-304 | Paper realism: queue position for resting limits, matching on trade prints (`md_trades`), latency model, triple-swap and holiday roll days, maker/taker fee tiers | goal 03 | 06/10 | Open |
| B-305 | Pro ticket (pips from the registry `pipSize`, hotkeys, OCO two-leg editor, trailing in pips, depth-aware sizing) and streaming blotter on the private WS channels | goal 03 | 04 | Done (goal 04; depth-aware sizing = order book click-to-price and the preview's depth walk, see B-406 for aggregated depth) |
| B-306 | Novice "Make a trade" flow wired to `POST /orders/preview` and `POST /orders` (market + protective stop, plain-language preview) | goal 03 | 08 | Open |
| B-307 | Margin close-out / stop-out automation at a margin level set by Compliance (OQ-B3); margin-call notices | goal 03 | 09 | Open |
| B-308 | Day/week start equity from a scheduled snapshot at the roll time (today: first valuation of the UTC day/ISO week, in-process cache) and loss-limit periods in the customer's time zone | goal 03 | 09 | Open |
| B-309 | Multi-currency cash sub-ledgers (hold balances in several currencies) and base-currency change after activity | goal 03 | post-RC | Open |
| B-310 | FX conversion on the bid/ask side (today mid × conversion bps) and show both legs of a triangulated rate | goal 03 | 09 | Open |
| B-311 | Reconciliation against a LIVE broker's positions and cash; route critical alerts to on-call (links B-012) | goal 03 | 10 | Open |
| B-312 | OpenAPI response schemas for the trading, kill switch and appropriateness endpoints, then SDK generation (with B-004/B-209) | goal 03 | 10 | Open (retargeted from 04 with B-004) |
| B-313 | Appropriateness content: Compliance-authored questions per jurisdiction and language, periodic re-assessment; add knowledge-check (goal 08) and suitability (goal 09) definitions to the questionnaire engine | goal 03 | 08/09 | Open |
| B-314 | Kill switch global scope for risk officers/admins (halt every account's robots, platform-wide cancel) | goal 03 | 09 | Open |
| B-315 | Distributed order-rate limits (per account and per robot) in Redis for multi-replica deployments | goal 03 | 10 | Open |
| B-401 | Move the Risk tab analytics (historical VaR, correlation clusters) to a quant-service endpoint; the api computes them with `@kora/domain/risk-analytics.ts` and labels `source: 'api'` meanwhile | goal 04 | 06/10 | Open |
| B-402 | Chart drawings saved per user on the server (today `localStorage` per symbol) and more tools (rectangle, Fibonacci, text notes) | goal 04 | 10 | Open |
| B-403 | Push alert triggers to the browser (private `alerts:{accountId}` channel or the account channel) instead of 5 s polling; more indicator conditions (MA cross, ATR breakout) | goal 04 | 09 | Open |
| B-404 | Render the visual-regression baseline inside the CI image (same Chromium and fonts) or regenerate it once there (`--update-snapshots`) | goal 04 | 10 | Open |
| B-405 | Lighthouse in CI with budgets (LCP < 2.5 s at 4× CPU, TBT < 300 ms); split the chart and dock bundles further (TBT 730 ms at 4× CPU today) | goal 04 | 10 | Open |
| B-406 | Order book: 20 levels and price-grouping (aggregation) from the feed (`KORA_MD_DEPTH_LEVELS`); depth-aware size suggestions in the ticket | goal 04 | 10 | Open |
| B-407 | Watchlist column sorting, custom columns (volume, high/low), and per-list alerts; symbols beyond the gateway's 300-channel cap stream only while on screen | goal 04 | 08/10 | Open |
| B-408 | Position-level source attribution (manual, robot, AI draft) from the fills' orders; today the blotter shows the source of the latest filled order | goal 04 | 06 | Open |
| B-409 | Chart: create orders from the chart (context menu "buy limit here"), and a keyboard-reachable data table of visible candles for screen-reader users | goal 04 | 10 | Open |
| B-410 | Hotkey conflict detection and per-layout hotkeys in Settings | goal 04 | 10 | Open |
| B-601 | AI regime filter: goal 07's regime model feeds the `ai_regime` condition (probability per bar, point-in-time, calibrated); backtests replay stored regime probabilities; `whenUnavailable` keeps working when the model is down | goal 06 | 07B (see B-701) | Open |
| B-602 | Copilot on `/robots`: explain a signal from `GET /signals/:id/features`, draft a new strategy version through `POST /strategies/:id/versions` (human saves), draft optimisation suggestions ranked by OOS | goal 06 | 07 | Done (goal 07; optimisation-ranked suggestions → B-705) |
| B-603 | Quant service on the robots' live path: health-gated runner (skip, alert), OpenTelemetry spans api → runner → quant (with B-507), horizontal scale-out of quant and runner | ADR 0006 | 10 | Open |
| B-604 | Research history: a data-provider interface for long licensed histories per venue (today SIMULATED backfill, 10 days in dev); per-bar FX history for `fxToBase` | goal 06 | post-RC (Sponsor, OQ-M2/OQ-B2) | Open |
| B-605 | Robot position segregation (sub-accounts or per-robot position keys) so manual trades in the same symbol cannot interfere with a robot's reduce-only exits | ADR 0006 | 09 | Open |
| B-606 | Robot equity snapshots (per bar close) → live column of the KPI table (live Sharpe, DD, etc.) and a mark-to-market tracking error next to today's realised-basis one | goal 06 | 09 | Open |
| B-607 | Backtester realism: depth/impact beyond the top of book, partial fills, triple-swap roll days, per-venue funding calendars (links B-304) | goal 06 | 10 | Open |
| B-608 | Service authentication for the bot runner: mTLS or short-lived signed service JWTs with rotation from the vault, per-runner identity (today a shared secret) | ADR 0006 | 10 | Open |
| B-609 | Promotion step-up through Keycloak (AUTH_PROVIDER=keycloak) and the real LIVE path (broker adapter, compliance sign-off, per-session 2FA) — Sponsor decision | ADR 0006 | post-RC (Sponsor) | Open |
| B-610 | Robot supervisor and runner HA: leader election across api replicas (with B-302), distributed per-robot order-rate counting (with B-315), BullMQ job retention and dead-letter dashboard | goal 06 | 10 | Open |
| B-611 | SDK: typed strategies / backtests / robots / signals methods (the web uses `apps/web/src/lib/robots/client.ts` meanwhile), with B-004 | goal 06 | 04/10 | Open |
| B-612 | Builder UX: keyboard reordering of chips, undo/redo, inline editing of literal values, multi-window sessions, per-template onboarding; visual regression against the prototype (B-011) | goal 06 | 08/10 | Open |
| B-613 | Long optimisations and walk-forwards as async BullMQ jobs with progress and cancellation; result cache keyed by input hash (with B-503) | goal 06 | 10 | Open |
| B-614 | Templates for goal 08: plain-language copy review (S1 + S8, like B-504), FR translations (B-013), risk-level rationale per template | goal 06 | 08 | Open |
| B-701 | `ai_regime` condition: no cheap calibrated regime model on SIMULATED data in goal 07, so it stays `not_available`. 07B's regime detector (HMM / volatility clustering) writes point-in-time probabilities per bar and calibration rows `trend:regime:<tf>`; the evaluator branch in `bt/evaluate.py` reads them inside the look-ahead guard | goal 07 | 07B | Open |
| B-702 | Live prediction logging for robot signals: write an `ai_predictions` row per non-hold decision at decision time (raw score from contributions) and resolve it from the robot's closing fills (needs position-level attribution, B-408/B-605); today strategy calibration uses OOS backtest trades | goal 07 | 07B/09 | Open |
| B-703 | Run the eval suite against the live provider (`pnpm evals:live`) once a key exists, record cassettes (`KORA_AI_RECORD_DIR`) and run `KORA_AI_PROVIDER=replay` in CI; tune prompts on failures (OQ-A2) | goal 07 | 07B | Open |
| B-704 | Distributed / sliding-window AI rate limits and budget alerts (80 % / 95 % of the org budget) in Alertmanager; per-org budgets from an `organisations` table once tenancy exists | goal 07 | 10 | Open |
| B-705 | Copilot suggestions from research: optimisation / sensitivity results ranked by OOS ("flat plateau vs lucky spike") as strategy drafts, with the trial count and DSR shown next to the draft | goal 07 | 07B/10 | Open |
| B-706 | Copilot UX: conversation history per panel (multi-turn), keyboard shortcut to focus the chat, cancel button while streaming, FR translations (with B-013), human copy review of the novice explanations (S1 + S8) | goal 07 | 08/10 | Open |
| B-707 | Response-cache invalidation on data change (quotes/fills) instead of TTL only; semantic de-duplication of near-identical questions | goal 07 | 10 | Open |
| B-708 | Bias rule (strip): replace the fixed-weight logistic score with a trained, walk-forward-validated model per asset class (07B trend models) and show its OOS skill next to the confidence | goal 07 | 07B | Open |
