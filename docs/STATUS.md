# KORA — delivery status

Last updated: 2026-09-26 (goals 04 and 06 merged; goal 07 AI copilot; goal 07B market intelligence; goal 08 Novice view merged with 07 and 07B; goal 09 risk, compliance and governance).

| Gate | Goal | State |
|---|---|---|
| G0 | 00 master plan | **Done**: `docs/plans/00-master.md`, ADR 0000/0001, charter |
| G1 | 01 foundation | **Done, with deferrals**: see `docs/plans/01-foundation.md` §4 and §6 |
| G2 | 02 market data | **Done, with deferrals**: see `docs/plans/02-market-data.md` §7 and §8 |
| G3 | 03 OMS, paper engine, risk, kill switch (+ B-018 appropriateness, B-501) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/03-oms.md` §6 (deferred items in §6.3) |
| G4 | 04 Pro terminal UI (+ B-009, B-011, B-208, B-210, B-305) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/04-pro-terminal.md` §6 (deferred items in §6.5) |
| G5 | 05 gain simulator | **Done, with deferrals**: see `docs/plans/05-gain-simulator.md` (paper import now uses real fills, B-501 done in goal 03; human copy review owed) |
| G6 | 06 robot trader (+ B-301, B-502) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/06-robot-trader.md` §6 (deferred items in §6.3) |
| G7 | 07 AI copilot (+ B-602) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/07-ai-copilot.md` §6 (live-provider eval pending a key, OQ-A2; deferred items in §6.3) |
| G7B | 07B market intelligence (+ B-601, B-701) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/07b-market-intelligence.md` §6 (all data SIMULATED, providers flagged stubs, OQ-M3/OQ-M4; live-provider evals pending a key, OQ-A2; deferred items in §6.3) |
| G8 | 08 Novice view (+ B-013, B-017, B-306, B-505, B-506, B-614; B-504 prep) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/08-novice-view.md` §6 (deferred items in §6.4) |
| G9 | 09 Risk, compliance and governance (+ B-003 part, B-007, B-014, B-202, B-203, B-303, B-314, B-801, B-810) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/09-governance.md` §6 (deferred items in §6.3; regulatory values stay placeholders with owners) |

## What shipped in goal 01

- **Monorepo:**
  - pnpm + Turborepo;
  - shared TS/ESLint/Prettier configs (`packages/config`);
  - ruff and mypy configs in `services/quant/pyproject.toml`.
- **Native dev services:** `scripts/dev-db.sh` (Postgres :55432, Redis :56379, `.data/`). `pnpm dev` works without Docker.
- **API (`apps/api`):**
  - dev OIDC IdP (sign-up, scrypt, TOTP enrolment and verification, ES256 JWT + JWKS);
  - global auth guard (CSRF, MFA rule, `@Roles`);
  - `user_preferences`;
  - `POST /kill-switch` (audited intent);
  - `GET /audit`, `GET /audit/verify`;
  - `/health` (db, redis, keycloak);
  - OpenAPI at `/docs`.
- **Audit:** append-only, hash-chained `audit_events`. Insert-only runtime role, owner-level immutability trigger, tamper detection with the first broken id.
- **Design system (`packages/ui`):**
  - pro-dark and novice-light tokens;
  - 16 primitives, including `HoldToConfirmButton`, decimal-safe `NumberInput`, `DirectionBadge`, and `Money`/`Price`;
  - Storybook with the a11y addon;
  - axe on every story (jsdom and Chromium);
  - contrast check (106 pairs).
- **Web (`apps/web`):**
  - login, sign-up and QR TOTP enrolment;
  - middleware session and role guards (friendly 403) with a CSP nonce;
  - Pro shell (top bar, left rail, status bar) and Novice shell (tabs, risk banner, mobile bottom bar);
  - Pro ⇄ Novice toggle, persisted and instrument-preserving, with a "what changed" note;
  - kill switch (1.5 s hold by mouse, touch, Space or Ctrl+Shift+K → three scopes → audit event);
  - audit viewer with chain verification; settings.
- **Services:** quant (FastAPI `/health`) and bot-runner (BullMQ heartbeat worker, `/health`).
- **Infra:** compose reference (Timescale, Redis, Keycloak, OTel, Prometheus, Grafana), Keycloak realm with conditional OTP, Dockerfiles, and the GitHub Actions CI.

## Stubbed or placeholder (explicit in the UI)

- The Pro terminal (chart, order book, full ticket, streaming blotter, ⌘K palette) is live since goal 04.
- The robot builder, auto-invest and learn pages are placeholders (robots: goal 06).

## Deferred (reasons in plan 01 §6)

- The Keycloak and compose runtime path (B-001).
- The Trivy and image builds (B-008).
- A GitHub Actions run (cannot push from this session).

## What goal 02/03 needs to know

- **Start the DB:** `bash scripts/dev-db.sh start`, or just `pnpm dev`. Migrate with `pnpm db:migrate`; use `pnpm db:migrate --all` to also migrate `kora_test`.
- **Add migrations:** as `apps/api/migrations/NNNN_name.sql`. They are forward-only and checksummed. Each one must `GRANT` explicitly to `kora_app` (and `kora_audit_reader` for read-only). Timescale: `create_hypertable` only inside `IF EXISTS (select from pg_extension where extname='timescaledb')`.
- **Audit:** inject `AuditService` and call `record({actorId, actorType, action, entity, entityId, payload}, client?)`.
  - Pass the transaction `client` so the audit row commits atomically with the business change. The transaction must be READ COMMITTED.
  - Payload numbers must be safe integers. Send decimals as strings.
  - Action names look like `kill_switch.requested`, matching the regex `^[a-z0-9_]+(\.[a-z0-9_]+)*$`.
- **Auth in the API:** every route is authenticated by default. Use `@Public()` to opt out and `@Roles(...)` to restrict. Non-novice roles always need `amr: otp`. `@CurrentPrincipal()` gives `{sub, roles, mfa}`.
- **Auth in tests:** use the real flow (`apps/api/test/helpers.ts`):
  - `createUser(app, 'novice' | 'trader', extraRoles?)` signs up (always `novice`, B-018), and for `trader` passes the appropriateness assessment through `POST /appropriateness/attempts`, then logs in again with TOTP enrolment/verify; returns a bearer token. `passingAnswers()` / `failingAnswers()` derive from the questionnaire data file.
  - `nextTotpWindow()` advances the faked `Date` 31 s, so repeated logins don't hit TOTP replay protection.
  - Extra roles are granted with a direct owner SQL insert.
  - Send `x-kora-csrf: 1` on unsafe requests unless you use `Authorization: Bearer`.
  - e2e uses `apiSignIn(page, type)` in `apps/web/e2e/helpers.ts` (same assessment flow; `answerKey()`/`answerIndex()` for the web page).
- **Decimals:** `import { dec, quantize, roundToTick, Decimal } from '@kora/domain'`. `dec(0.1)` throws by design. The UI formats via `formatPrice(value, precision)` and `formatMoney` from `@kora/ui`.
- **Kill switch:** the web calls `POST /kill-switch {scope, source, reason?}` with scopes `robots | robots_cancel | robots_cancel_flatten`; since goal 03 it runs the engine and audits each child action (see the goal 03 section).
- **Order types:** the server capability is `GET /me → capabilities.orderTypes` (novice view = `['market']`). The goal 03 OMS must enforce role guardrails server-side (goal 08).
- **Ports:**
  - dev: web 3000, api 4000, quant 8000, bot-runner 4100;
  - e2e: api 4010, web 3010, db `kora_e2e`;
  - integration tests: db `kora_test`.
- **Env:** everything lives in the repo-root `.env`. The api and web load it themselves and never override variables that are already set.

## What shipped in goal 02 (market data, all SIMULATED)

- **Global registry** (sponsor scope update). Migration `0002`, generated from `packages/market-data/src/seed`, contains:
  - `venues`: 19 venues, all continents (ISO 10383 MIC, IANA timezone, calendar data with lunch breaks, holidays and early closes);
  - `instruments`: 51 rows covering the prototype majors plus one per venue and every asset class (`equity, etf, bond, future, option, fx, metal, energy, agri, crypto, index, cfd, fund`), with ISIN/FIGI, tick, precision, qty step, sessions and placeholder margin tiers;
  - `asset_classes` (stale thresholds);
  - `instrument_aliases`.
- **Session status** from timezone + calendar (`sessionStatus` in `@kora/domain`), tested across DST.
- **`packages/market-data`:**
  - `MarketDataAdapter` interface;
  - deterministic `SimulatedMarket` / `SimulatedAdapter` (GBM + regimes + spreads + depth + trades + calendar shocks; outage → gap semantics; `freeze()` stall drill);
  - `SeqGapDetector`, `OrderBook`, OHLCV aggregation, token-bucket `Conflator`, registry rounding helpers;
  - `SimulatedCalendarProvider`;
  - three flagged stub adapters (`broker-fxcfd`, `crypto-testnet`, `equities-provider`) with hand-crafted fixture contract tests.
- **API (`apps/api/src/market-data`):**
  - `FeedService`: in-process or `md:feed`; gap → snapshot resync; staleness; status heartbeat; trades and 1 s bars persisted; candle rollup; SIMULATED backfill;
  - WebSocket gateway at `/ws`: auth; reference-counted Redis subscriptions; conflation; pre-framed corked fan-out; heartbeat-loss detection;
  - REST endpoints `/instruments`, `/venues`, `/candles`, `/quotes`, `/depth/:symbol`, `/calendar` and `/market-data/status`;
  - admin-only, audited `POST /market-data/feeds/:source/stop|start`.
- **SDK:** `MarketDataSocket` (reconnect with backoff and jitter, resubscribe, heartbeat) and REST methods. OpenAPI regenerated.
- **Web:** the Pro terminal watchlist streams live SIMULATED quotes with a STALE badge (e2e). Chart, order book and calendar panels are goal 04.
- **Load test:** `apps/api/load/ws-fanout.mjs`. 500 clients × 20 of 200 symbols at 10 Hz gives p99 13.1 ms (results in `apps/api/load/results/`).

## Deferred in goal 02 (reasons in plan 02 §8)

- TimescaleDB caggs/hypertables (B-201).
- k6 execution (B-207).
- Real provider transports (B-205, OQ-B1/B2).
- Licensed calendars and tick bands (B-204, OQ-M2).
- Margin tiers (OQ-M1).
- GBX/ZAc minor units (B-202).

## What goal 03 needs to know (market data)

- **Registry:** import `MarketDataModule`'s exported `InstrumentsRepository` and call `load()`. You get `instruments` (`InstrumentSpec`: `tickSize`, `pricePrecision`, `qtyStep`, `qtyPrecision`, `minQty`, `contractSize`, `pipSize`, `marginRates` (placeholders), `feeScheduleId`, `tradingSessions`, `venue`), plus `venues`, `staleAfterMs` and `aliases`.
  - Round every price and quantity with `roundPrice/formatPrice/roundQty/formatQty` from `@kora/market-data`, never with literals.
  - Is the market open? Use `sessionStatus(spec.tradingSessions ?? venue.calendar, tz, now)` from `@kora/domain`.
- **Getting a quote or depth inside the engine:**
  - Point read: inject `ChannelHub` and call `getLast([quoteChannel(sym), depthChannel(sym)])`. It returns the last-value JSON (`Quote` / `DepthSnapshot`, 10 levels best-first, sizes on the qty grid).
  - Streaming: subscribe with ioredis to `${KORA_MD_REDIS_PREFIX}quotes:{symbol}` and `…depth:{symbol}` (default prefix `kora:md:`). The payloads are the same objects the WS sends as `data`, and they are not conflated on the bus.
  - REST equivalents: `GET /quotes?symbols=…` and `GET /depth/:symbol`.
- **Fill safety:** refuse or hold fills when `quote.stale === true`, when the latest `status` (channel `status`, or `GET /market-data/status`) is not `ok` for the quote's `source`, or when the session is not `open`. Use `DepthSnapshot` to walk the book for slippage. Quotes carry `seq`, `exchangeTs` and `receivedTs` for the audit trail.
- **Channels:**
  - `quotes:{symbol}` and `depth:{symbol}`: WS conflated to 10/s, burst 2;
  - `candles:{symbol}:{tf}` with tf in `1s 1m 5m 15m 1h 4h 1D` (`closed` flag);
  - `status`: `ok | degraded` from the feed, `down` when the feed heartbeat is lost.
- **History for charts, backtests and the simulator:** `GET /candles` (history + live merged). Tables `md_candles` (live rollup), `md_candles_history` (SIMULATED backfill) and `md_bars_1s`/`md_trades` (7-day retention).
- **Adapter interface:** `MarketDataAdapter` is market data only. Orders need a separate broker interface in goal 03. `LIVE_TRADING_ENABLED` is untouched and every stub's live transport refuses to connect.
- **Tests:** `createUser(app, type, roles, { realClock: true })` keeps `Date.now` moving, which the feed needs. Set `KORA_MD_FEED=inprocess` (plus `KORA_MD_SYMBOLS`) before `startApp()` to run the feed in an integration test; the default there is `off`. The test Redis prefix is per process.
## Goal 05: gain simulator (G5: done, with deferrals)

Plan and evidence: `docs/plans/05-gain-simulator.md`. ADR 0005. Built in parallel with goal 02, on its own branch. Gate table row to add when merging: `| G5 | 05 gain simulator | **Done, with deferrals**: see plan 05 §5–§6 |`.

### What shipped

- **Quant (`services/quant/src/kora_quant/sim/`):**
  - `POST /mc/project` (parametric edge) and `POST /mc/from-trades` (circular moving-block bootstrap, block auto `⌈n^{1/3}⌉` or user-set);
  - `POST /analytics/paper` (Decimal FIFO analytics over `Fill[]`) and `POST /reality-checks`;
  - numpy PCG64 plus a numba kernel, seeded and deterministic, LRU-cached by input hash;
  - defaults: 10k paths, max 50k;
  - 10k × 1,000 trades in **163 ms p95** (`bench/RESULTS.md`);
  - 85 pytest tests, 98.9% coverage, passing on Python 3.11 and 3.12.
- **Model:** R-multiple outcomes with costs on by default, fat tails, a stress edge cut, three sizing models (fixed-fractional, fixed amount, Kelly fraction), withdrawals and a ruin floor.
- **Outputs:**
  - P5–P95 bands, final distribution, P(below start), risk of ruin plus a closed-form estimate;
  - drawdown median/P95/histogram, time under water, longest losing streak;
  - expectancy after costs, full Kelly after costs and tails, and the user/Kelly ratio;
  - 3 sample paths and reality checks.
- **Reality checks:** 6 pure rules with rationales in `docs/quant/reality-checks.md`. The model is described in `docs/quant/monte-carlo.md`.
- **API (`apps/api/src/sim/`):**
  - `POST /sim/project`, `POST /sim/from-trades`, `GET /sim/paper/analytics`, `POST /sim/paper/project`;
  - zod validation with plain-language rejections;
  - `KORA_SIM_RATE_LIMIT` per client per minute (default 60);
  - audit events `sim.projection_run`, `sim.bootstrap_run` and `sim.paper_projection_run`;
  - quant failures map to 502/503 with "Nothing was simulated".
- **Web Pro (`/simulator`):**
  - assumptions panel;
  - SVG fan chart (bands, median, start, ruin floor, 3 sample paths) with the SIMULATED watermark;
  - 5 KPI tiles, drawdown histogram, risk table, reality checks;
  - stress and fat-tail toggles;
  - "Project from my paper results";
  - "Import from backtest" placeholder (goal 06);
  - A/B compare (overlay and table);
  - CSV and PNG export.
- **Web Novice (`/practice`):**
  - three plain questions: how much, how often, how careful;
  - good / typical / bad year, a band chart, "This is a simulation, not a promise";
  - glossary links, with an automated jargon scan in e2e.
- **Tests:**
  - api integration: 18 new (43 total);
  - web unit: 8 new;
  - e2e: 5 new (21 total, all green).

### Stubbed or placeholder

- Paper analytics use the account's real fills since goal 03 (B-501). The deterministic SIMULATED fixture (`apps/api/src/sim/paper-fixture.ts`) is only used, and labelled, for accounts with no fills yet.
- "Import from backtest" is an `aria-disabled` button that names goal 06 (B-502).

### What goals 03, 06 and 08 need to know

- **Goal 03:** replace `paperFixtureFills()` in `SimController.paperAnalytics()` with the account's fills (same `Fill` shape, decimal strings, tz-aware `ts`). Pass `contractMultipliers` from the instrument registry for non-quote-currency P&L. Drop `?simulated_source=true` once the fills are real.
- **Goal 06:** "Send to Monte Carlo" posts `{trades: number[] (R multiples), source: 'backtest_in_sample' | 'backtest_out_of_sample', riskPct, blockSize?}` to `/sim/from-trades`. The `small_sample` and `in_sample_source` checks fire on their own.
- **Goal 08:** the Practice mapping lives in `apps/web/src/lib/sim/practice.ts`, and the glossary and jargon list in `apps/web/src/lib/sim/glossary.ts`. Human copy review is B-504, and the product stance on the skill-free edge is OQ-Q1.
- **Env:** `QUANT_URL` (default `http://127.0.0.1:$QUANT_PORT`), `QUANT_TIMEOUT_MS`, `KORA_SIM_RATE_LIMIT`. Playwright starts uvicorn on `E2E_QUANT_PORT` (default 8010), and the api gets `QUANT_URL` automatically.
- **Numbers:** simulation outputs are float estimates, always labelled SIMULATED and never booked. Paper P&L is Decimal (ADR 0005 §4).

## Goal 03: OMS, paper engine, pre-trade risk, kill switch (G3: done, with deferrals)

Plan and evidence: `docs/plans/03-oms.md` §6. ADR 0003. Lead seats S4, S2, S8.

### What shipped

- **Appropriateness (B-018, Sponsor decision OQ-S2):** sign-up creates `novice` only (API, web, SDK, tests). Generic questionnaire engine (`@kora/domain` `questionnaire.ts` + `QuestionnaireService`), versioned JSON data (SIMULATED placeholders, OQ-C1), `GET /appropriateness/questionnaire`, `POST /appropriateness/attempts` (server-graded, pass mark 75 % and 24 h cool-down from data with env overrides, audited with version and score, answers never stored). A pass grants `trader`, switches the view to Pro and signs the user out; the next login forces TOTP enrolment. Web page `/appropriateness` (link "Unlock Pro trading" in the user menu).
- **Domain (`packages/domain/src/trading`):** order schemas (market, limit, stop, stop-limit, trailing, bracket, OCO; DAY/GTC/IOC/FOK/GTD; SL/TP; reduce-only; post-only), exhaustive state machine, positions (average cost), double-entry ledger, registry-driven costs (commission, spread, swap, FX conversion) and depth-walk slippage, account valuation, preview, 23 risk rules. fast-check properties for the ledger, positions and P&L.
- **API (`apps/api/src/trading`):** migrations 0003/0004; `OmsService` (idempotent submit, amend, cancel), `PaperEngineService` (fill safety, triggers, partial fills, brackets/OCO, reduce-only hygiene, daily roll), `EngineLoopService` (Redis-driven matching, sweeps, expiries), pre-trade risk (`evaluateRisk` called from `OmsService.evaluate`), `KillSwitchService`, `ReconciliationService` (60 s + on demand, critical alerts), FX service, base-currency accounts, private WS channels, `BrokerExecutionAdapter` + refusing LIVE stub. `AuditService.recordMany`. Paper analytics from real fills (B-501).
- **Web:** top-bar equity / day P&L / margin used / daily loss-limit meter; kill switch shows engine results; halted banner with a resume dialog (reason required); minimal ticket wired to preview/place and a minimal blotter (positions, open orders, fills; close/cancel); Novice home shows the practice balance.
- **Results:** 1,000 open orders + 4 positions halted/cancelled/flattened in 178 ms; risk rules p95 0.14 ms (4.9 ms with context load); integration 118 tests, e2e 26, all green.

### Stubbed or placeholder

- Fees, swaps, FX conversion fee, margin rates, risk limits, starting cash and the questionnaire content are SIMULATED placeholders (OQ-M1, OQ-M5, OQ-R5, OQ-R6, OQ-C1).
- Robots do not exist yet: the halt blocks `robot:*` orders and a `kora:ctl:robots` message is published for goal 06 (B-301).
- LIVE: stub only, refuses; `LIVE_TRADING_ENABLED=false`.
- The ticket, blotter and Novice trade card are minimal (goals 04 and 08).

### Deferred

B-301 robot runner wiring, B-302 matching-loop scale-out, B-303 owner access to system audit events, B-304 paper realism, B-305 Pro ticket and streaming blotter, B-306 Novice trade flow, B-307 margin close-out (OQ-B3), B-308 scheduled equity snapshots, B-309 multi-currency cash, B-310 bid/ask FX conversion, B-311 LIVE reconciliation, B-312 OpenAPI response schemas, B-313 questionnaire content, B-314 global kill switch, B-315 distributed rate limits.

### What goals 04, 06 and 08 need to know

- **REST (all PAPER, decimal strings, base currency):**
  - `POST /orders/preview` → `{instrument{assetClass, quoteCcy, pricePrecision, tickSize, qtyStep, minQty, multiplier, feeScheduleId, feesSimulated}, market{bid, ask, session, dataState, dataReason}, novice, preview{estimatedPrice, exceedsVisibleDepth, currency, notional{quote, quoteCcy, base}, fees{commission, spread, fxConversion, total}, margin{rate, required, change, usedAfter, freeAfter, equity}, lossIfStopHit{stopPrice, price, costs, total, pctEquity} | null, rewardIfTargetHit{targetPrice, amount} | null, rewardRisk ("2.00" = 1:2) | null, fx{from, to, rate, conversionBps, conversionCost} | null, confirmation{required, reasons[]}, issues[]}, risk{ok, violations[{code, message}]}, timings}`. Same body as `POST /orders` without `clientOrderId`. Show `confirmation.reasons` in the confirm dialog; novices always confirm.
  - `POST /orders` (`clientOrderId` required; 201 new, 200 replay, 409 reused, 422 `{error:'risk_rejected', code, message, violations, order}`), `GET /orders?status=open|all`, `GET /orders/:id` (with `children`), `PATCH /orders/:id {qty|limitPrice|stopPrice|trailAmount}`, `DELETE /orders/:id`, `GET /positions`, `POST /positions/:symbol/close`, `GET /fills`, `GET /accounts/me`, `PUT /accounts/me/settings {confirmMode, confirmNotionalAbove, confirmLossPctAbove, baseCurrency (before activity), riskLimits (tighten only)}`, `GET /accounts/me/ledger`, `GET /alerts`, `POST /reconciliation/run`.
  - Kill switch: `POST /kill-switch {scope, source, reason?}` → `{accepted, scope, label, auditEventId, engine:'paper', killSwitchId, accountId, halted, alreadyHalted, robotsHalted, ordersCancelled, positionsFlattened, flattenPending[], durationMs}`; `POST /kill-switch/resume {reason}` (trader/quant/risk_officer/admin; `?accountId=` for risk officers/admins); `GET /kill-switch`.
  - SDK: `KoraClient.previewOrder/placeOrder/orders/order/amendOrder/cancelOrder/positions/closePosition/fills/account/updateAccountSettings/killSwitch/killSwitchState/resumeTrading/appropriateness/submitAppropriateness`.
- **WebSocket (same `/ws` gateway):** `orders:{accountId}` → `{type:'orders', accountId, orders: OrderDto[]}` per committed transaction, never conflated; `positions:{accountId}` → `{type:'positions', positions: PositionDto[]}`; `account:{accountId}` → `{type:'account', account: AccountView}` (coalesced 50 ms). Owner only (risk officers/admins may read any); others get `forbidden`. The account id is `GET /accounts/me → id`.
- **Risk codes** (machine code + plain message): `MAX_ORDER_NOTIONAL, FAT_FINGER, MAX_POSITION, MAX_LEVERAGE, INSUFFICIENT_MARGIN, DAILY_LOSS_LIMIT, WEEKLY_LOSS_LIMIT, ORDER_RATE_LIMIT, SESSION_CLOSED, INSTRUMENT_NOT_TRADABLE, NO_MARKET_DATA, MARKET_DATA_STALE, FEED_NOT_OK, FX_RATE_UNAVAILABLE, NOVICE_ORDER_TYPE, NOVICE_STOP_REQUIRED, NOVICE_LEVERAGE, REDUCE_ONLY_WOULD_INCREASE, POST_ONLY_WOULD_TAKE, STOP_LOSS_WRONG_SIDE, TAKE_PROFIT_WRONG_SIDE, TRADING_HALTED, FOK_INSUFFICIENT_DEPTH` (`RISK_CODES` in `@kora/domain`).
- **Robots (goal 06):** submit through `OmsService.submit({userId, roles, actor: {type: 'robot', id: robotId}, source: 'robot:<uuid>'}, PlaceOrderRequest)`, the same path as REST (risk, audit, idempotency on `clientOrderId`). While the account is halted, robot orders get `TRADING_HALTED`; listen to Redis `kora:ctl:robots` (`{action:'halt'|'resume', accountId, scope, reason, auditEventId, ts}`) to stop/restart runners. Audit actor type is `robot`.
- **Questionnaire engine (goals 08, 09):** add a JSON definition (`id`, `version`, `kind: knowledge_check | suitability`, `passMarkPct`, `cooldownMinutes`, questions with option `points`) to `QUESTIONNAIRE_FILES` in `apps/api/src/appropriateness/questionnaire.service.ts`; use `QuestionnaireService.get/view/grade/record/lastAttempt/cooldownUntil` and `@kora/domain` `grade()`/`publicView()`. Published versions are immutable (bump the version). Env overrides: `KORA_<ID>_PASS_MARK_PCT`, `KORA_<ID>_COOLDOWN_MINUTES`.
- **Novice (goal 08):** guardrails are server-side (`NOVICE_*` codes) for novice-only users and anyone in the Novice view; closing a position never needs a stop. Use `POST /orders/preview` for "most you could lose" (`lossIfStopHit.total`) and `GET /accounts/me` for the balance.
- **Numbers:** quantities follow the registry grid (`qtyStep`, `minQty`); prices the `tickSize`; `multiplier` comes from `asset_class_trading.multiplier_mode` (FX/metals/crypto/equities in units). Marks are exit-side (bid for longs, ask for shorts). FX sessions close at weekends, so day-independent tests use BTC/USD.
- **Env:** `KORA_PAPER_*`, `KORA_RISK_*`, `KORA_ORDER_RATE_LIMIT`, `KORA_ENGINE_*`, `KORA_TRADING_*`, `KORA_RECONCILIATION_INTERVAL_MS`, `KORA_APPROPRIATENESS_*` (see `.env.example`). Integration tests set `KORA_ENGINE_ENABLED=false` and drive matching with `EngineLoopService.matchSymbol`; `test/market-fixture.ts` writes quotes/depth/status into Redis.

## Goal 04: Pro terminal UI (G4: done, with deferrals)

Plan and evidence: `docs/plans/04-pro-terminal.md` §6. ADR 0004. Lead seats: S6, S1, S2. Built in parallel with goal 06.

### What shipped

- **Dockable terminal (`/terminal`, dockview).**
  - Default layout per `Main.png`: watchlist (2/12) over the calendar, chart (7/12) with the AI strip, order book | time & sales over the ticket (3/12), and a 186 px blotter (240 px from 1,000 px high).
  - Blotter tabs (Positions, Orders, Fills, Alerts, Risk) are dockable panels.
  - Named layouts per user (`/me/layouts`), a working layout in `localStorage`, and reset to default.
- **Watchlists (`/me/watchlists`).**
  - Majors + Global (one instrument per registry venue) by default; create, rename, delete, ≤ 500 symbols.
  - Add via ⌘K, drag or Alt+↑/↓ to reorder, Delete to remove.
  - Rows show mid, change %, spread (pips) and venue MIC + session badge ("Closed" is not "Stale", B-208). They flash for 150 ms and are virtualised (tested with 500 rows).
- **Chart (lightweight-charts v5).**
  - 1m–1D candles and volume.
  - EMA/SMA/VWAP/Bollinger/RSI/ATR from `@kora/domain/indicators.ts` (reference-tested).
  - Horizontal-line and trendline drawing, own fills as markers, last price tag, OHLC readout.
  - Working orders as draggable price lines (drag or arrow keys → confirm → PATCH).
- **Order book** (10 levels per side, cumulative bars, spread and mid; a level click or Enter fills the ticket limit) and **time & sales** (B-210 `trades:{symbol}` channel).
- **Pro ticket (B-305).**
  - All goal 03 order types, including the OCO editor.
  - Quantity in units, notional or % equity; SL/TP in price, pips or %; TIF (incl. GTD), reduce-only, post-only.
  - Live preview, debounced 150 ms.
  - Warnings: per-trade risk rule, event within 60 min, closed session, data state, no stop.
  - Confirmation dialog, plus a 600 ms hold for market orders above the threshold.
- **Blotter.**
  - Streams on the private channels, with a REST fallback.
  - Positions: close, reverse, SL/TP. Orders: amend inline, cancel, cancel-all (`DELETE /orders?symbol=`). Fills: with slippage.
  - Alerts: price/RSI, evaluated by the server (`/price-alerts`, audited).
  - Risk: `GET /risk/summary` (exposure by currency, VaR 95 % 1 day historical, correlation clusters, daily loss vs limit).
- **Keyboard and settings.**
  - Configurable hotkeys: B/S, Ctrl+Enter, Esc, Ctrl+Shift+K, Alt+1..5, ⌘K, and `?` for the cheat sheet.
  - Settings: colour convention, density, UTC/local, sound on fills (off), per-trade risk %.
- **⌘K palette (B-009).** In the Pro shell on every page: every registry instrument grouped by region/asset class, plus actions.
- **Status bar.** Feed state, tick-to-paint p95 and UTC/local clock.
- **API.** Migration `0040_terminal.sql`, `TerminalModule`, the feed's trade tape, `cancelAll`, and the test-only `KORA_TRADING_SESSION_OVERRIDE`, which is refused outside dev/test. SDK methods: `layouts/saveLayout/deleteLayout`, `watchlists/…`, `priceAlerts/…`, `riskSummary`, `cancelAllOrders`, `venues`, and socket helpers `trades/orders/positions/account`. `openapi.json` is regenerated.
- **Numbers.**
  - Tick-to-paint p95 42 ms; streaming CLS 0.0000.
  - Lighthouse desktop: LCP 1.4 s, performance 0.95, accessibility 1.00. At 4× CPU: LCP 2.1 s.
  - Prototype fit: mean IoU 0.973; perceptual Δ 0.040.
  - Tests: integration 125, e2e 36, web unit 29, domain 132.

### Stubbed or placeholder

- The AI strip is a placeholder (`KORA_AI_STRIP=placeholder`) with no numbers; goal 07 fills it.
- The Risk tab's VaR and correlations are computed in the api, not the quant service (B-401). All history is SIMULATED.
- The visual-regression run uses REST/WS fixtures (SIMULATED values echoing the prototype).

### Deferred

B-202 (to 09), B-004/B-312 (to 10), B-506 (to 08), B-401 to B-410 (see BACKLOG).

### What goals 07 and 08 need to know

- **AI strip slot (goal 07).**
  - Contract: `apps/web/src/lib/terminal/ai-strip.ts`. Call `registerAiStrip(Component)` once, client side, before `/terminal` mounts (for example from a module imported by the terminal page).
  - The component receives `AiStripSlotProps {symbol: string, timeframe: Timeframe, prefillTicket(draft)}`.
  - Set `KORA_AI_STRIP=on` (`off` hides the strip; `placeholder` is the default).
  - The strip is 42 px tall under the chart. Keep it one line and add a "Why?" disclosure inside it.
- **Ticket prefill for drafts (goals 07 and 08).**
  - Call `useTerminal.getState().prefillTicket(draft)` or `terminalApi.prefillTicket(draft)` (`apps/web/src/lib/terminal/store.ts`).
  - `TicketDraft = {symbol?, side?, type?, qty? (units), limitPrice?, stopPrice?, trailAmount?, stopLossPrice?, takeProfitPrice?, tif?, reduceOnly?, origin?: 'manual'|'order_book'|'chart'|'blotter'|'ai', note?}`.
  - With `origin: 'ai'`, the ticket shows "✦ Draft {note} · Review before placing". The order goes out with `source: 'ai-draft-accepted'` only after the user reviews and confirms (confirmation dialog / hold rules unchanged). Nothing can submit without the user.
  - Audit the suggestion itself (goal 07) and pass the audit id in `note` if useful.
- **Layout and theme hooks.**
  - Layouts: `apps/web/src/lib/terminal/layout.ts` has `PANEL_IDS`, `buildDefaultLayout(api)` and `isCompleteLayout(json)`. `/me/layouts` stores dockview JSON. Adding a panel means adding its id to `PANEL_IDS`; old saved layouts are then rejected and rebuilt from the default.
  - Window events: `kora:layout` `{action: 'open'|'reset'}`, `kora:focus-panel` `{id}`, `kora:palette` `{mode: 'go'|'add'}` and `kora:watchlist-add` `{symbol}`.
  - Theme: the dockview theme class `dockview-theme-kora` (`components/terminal/terminal.css`) reads only `--k-*` tokens. The colour convention and density are `data-colors` on `<html>` and `data-density` on the dock.
- **Goal 08 (Novice).** Reusable pieces:
  - `@kora/domain/terminal.ts`: `unitsFromQtyInput`, `protectivePrice`, `ticketWarnings`, `sessionBadge`, `quoteBadge`;
  - the indicator library;
  - `MarketStore` (one socket, frame-batched);
  - `useRegistry` / `searchInstruments`.

  The Novice view must not use the dock or advanced order types (server-enforced). Terminal settings live in `preferences.terminal` (`TerminalSettingsSchema`).
- **Goal 06 (robots).** Positions show a "Source" column from the latest filled order's `source` (`robot:<id>` → "Robot · id…"). Position-level attribution is B-408.
- **Env:** `KORA_AI_STRIP`, `KORA_ALERTS_ENABLED`, `KORA_ALERTS_EVAL_MS`, `KORA_TRADING_SESSION_OVERRIDE` (test only), and `E2E_MD_REDIS_PREFIX` (a second e2e stack on one host).

## Goal 06: Robot trader (G6: done, with deferrals)

Plan and evidence: `docs/plans/06-robot-trader.md` §6. ADR 0006, `docs/quant/backtester.md`. Lead seats S5, S2, S4, S8. Built in a worktree in parallel with goal 04 (migrations `0060+`).

### What shipped

- **DSL (`packages/domain/src/strategy`):** `kora.strategy` v1 zod schema (ENTRY / FILTERS / EXIT / SIZE; `compare`, `cross`, `session_window`, `venue_open`, `no_event`, `ai_regime`; ATR/% stops, ATR/R/% targets, trailing after x R, time stop; % risk, fixed, volatility-target sizing, max open positions), named parameters, semantic validation with plain messages, warm-up, parameter diff, canonical JSON + `strategyContentHash` (`@kora/domain/server`), templates (Trend-X, MeanRev-Gold, Breakout-Crypto), builder block catalog with pure `addBlock`/`removeBlock`, robot limits and research request schemas. Cross-language fixture shared with Python.
- **Quant (`services/quant/src/kora_quant/bt`):** event-driven portfolio bar backtester (fill at next open, conservative stop-first intrabar policy, gaps, trailing, time stops, end-of-data close, commission and funding from the registry cost model), mandatory look-ahead guard, IS/OOS split, anchored/rolling walk-forward with optional per-fold re-optimisation, metrics (CAGR, Sharpe, Sortino, Calmar, max DD + duration, win rate, profit factor, expectancy R/ccy, trades, exposure, turnover, cost drag), PSR/DSR, capped grid/random optimisation ranked by OOS, sensitivity grid, and `/bt/signal` (the live decision, same code). Endpoints `/bt/run`, `/bt/walk-forward`, `/bt/optimise`, `/bt/sensitivity`, `/bt/signal`.
- **API:**
  - `apps/api/src/strategies`: strategies + immutable versions (author, reason, audited parameter diff, optimistic concurrency), `/strategies/validate|schema|catalog`, research runs with SIMULATED point-in-time data (candles, registry session flags, SIMULATED calendar) and the paper engine's registry cost model, server-counted trials, `GET /strategy-templates` for every role.
  - `apps/api/src/robots`: robots (create/start/pause/version switch/limits, book from the robot's own fills, limit usage, KPIs, signals, audit feed), internal bot-runner API (B-301, service token), supervisor (heartbeats, loss/drawdown auto-pause with alerts, kill-switch listener), daily tracking error, promotion (evidence checklist, four-eyes risk sign-off bound to the limits hash, TOTP step-up, LIVE refused but recorded), `GET /signals/:id/features`.
  - Migration `0060_robots.sql` (append-only versions, runs, trials, signals, sign-offs, promotions; LIVE robots refused by trigger; four-eyes trigger).
  - Small additive changes: `OmsService.amend/cancel` optional actor; `DevIdpService.verifyStepUp` exported from `AuthModule`.
- **Bot runner (`services/bot-runner`):** BullMQ `bar_close` jobs from the goal 02 candle channels (one job per robot/symbol/bar), context → quant → decision through the api, 5 s heartbeats, kill-switch reaction on `kora:ctl:robots` (≈ 1 ms in the runner), reaction events on `kora:robots:events`, daily tracking job, `/health` with robot counts.
- **Web:** `/robots` monitor (robot list with run/pause and P&L, rule chips, IS/OOS equity with divider and drawdown, KPI table IS/OOS/WF/live, overfitting checks, sensitivity heatmap, walk-forward folds, Send to Monte Carlo, risk-limit meters, live audit feed, heartbeat, signal feature contributions, promotion checklist with 2FA dialog, hold-to-halt-all) and `/robots/builder` (drag-and-drop blocks with + buttons, inline parameter editing, live validation panel, JSON view, import/export, versioned save with a reason). The simulator's "Import from backtest" works (B-502).
- **Tests:** domain 21 new; quant 39 new (124 total, 97.7 % coverage); api unit 3 new; api integration 19 new (137 total); runner 11; web unit 3 new; e2e 3 new (29 total). See plan §6 for the per-criterion evidence.

### Stubbed or placeholder

- The AI regime condition evaluates to `not_available` until goal 07 (skipped or blocking, by the strategy's choice, and recorded on every signal). The copilot panel on `/robots` shows the stored feature contributions only.
- Research data is the SIMULATED candle history (10 days in dev by default); licensed history is a Sponsor item (B-604).
- Default robot limits and promotion thresholds are SIMULATED placeholders (OQ-R7, OQ-R8). Promotion is always refused (`LIVE_TRADING_ENABLED=false`).
- The live column of the KPI table shows P&L, fills and tracking error; live ratios need robot equity snapshots (B-606).

### Deferred

B-601 AI regime wiring, B-602 copilot on `/robots`, B-603 quant on the live path (health gating, tracing, scale), B-604 licensed history, B-605 robot position segregation, B-606 robot equity snapshots and live KPIs, B-607 backtester depth/impact realism, B-608 runner mTLS / service JWT, B-609 Keycloak step-up and the real LIVE path, B-610 supervisor/runner HA, B-611 SDK methods, B-612 builder UX extras, B-613 async long research jobs, B-614 template copy review.

### What goals 07, 07B and 08 need to know

- **Signal feature store (goal 07 `get_signal_features`):** `GET /signals/:id/features` (owner, risk officer, admin) → `{id, robotId, versionId, symbol, barTs, action, reason, outcome, outcomeDetail, orderId, features: {"ema:20": 1.0842, …}, conditions: [{block, index, type, label, result: true|false|'not_available', values, contribution (−1…1, tanh of the scaled margin), skipped}], explanation}`. List a robot's signals with `GET /robots/:id/signals?limit=`; every non-hold decision is also an audit event `robot.signal` (actor `robot`). Backtest trades carry the same `entrySignal.conditions` inside `backtest_runs.result` (`GET /backtests/:id`).
- **Strategy draft API (AI suggests, never executes):** build a candidate definition, check it with `POST /strategies/validate {definition}` → `{valid, issues[{path, message, severity}], contentHash, shortHash, warmupBars}`; show the diff with `paramsDiff()` from `@kora/domain`. Only a human saves it: `POST /strategies/:id/versions {definition, reason, baseVersionId}` (audited as the user; 409 `stale_version` when the base moved). Goal 07 should record its own `ai.suggestion` audit event (actor `ai`) and may add a `strategy_drafts` table; it must not call the robot endpoints.
- **Templates API (goal 08):** `GET /strategy-templates` (any signed-in role) → `{templates: [{id, name, summary, riskLevel: 'lower'|'medium'|'higher', symbols, timeframe, definition}], disclaimer}`. Everything else under `/strategies`, `/backtests`, `/robots` is trader/quant/admin only; a Novice auto-invest flow needs a server-side, guard-railed path decided in goal 08 (B-614).
- **Calibration hooks (goals 07/07B):** the `ai_regime` condition is `{regime: 'trending'|'ranging'|'volatile', minProbability, whenUnavailable: 'ignore'|'block'}`; the evaluator's `AiRegimeCondition` branch in `services/quant/src/kora_quant/bt/evaluate.py` is where per-bar, point-in-time regime probabilities (sent with each symbol's data) should be read, inside the look-ahead guard. For calibration ("when I said 0.6 it worked 57 %"), join `robot_signals` with the robot's subsequent fills (orders with `source = 'robot:{id}'`) or use backtest trades' `entrySignal` + `rMultiple`; trials per strategy are in `strategy_trials` (IS/OOS per-period Sharpe).
- **Runner / control plane:** `kora:ctl:robots` now also carries `{action: 'sync', robotId, accountId, status}`; the runner reports `{type: 'halted'|'decision', …}` on `kora:robots:events`. Heartbeat keys `kora:robots:hb:{robotId}`.
- **Env:** `KORA_SERVICE_TOKEN` (generated by `scripts/dev-db.sh`), `KORA_ROBOT_*`, `KORA_BOT_RUNNER_*`, `KORA_BT_*`, `KORA_PROMOTE_*`; e2e adds `E2E_BOT_RUNNER_PORT` and `E2E_MD_REDIS_PREFIX` (see `.env.example`). Integration tests spawn the real quant service (`scripts/py-run.sh`) and the runner (`tsx`).

## Goal 07: AI copilot (G7: done, with deferrals)

Plan and evidence: `docs/plans/07-ai-copilot.md` §6. ADR 0007 (threat model). Lead seats S7, S9, S8. Built in parallel with goal 08 (migration `0070`).

### What shipped

- **Gateway (`apps/api/src/ai`)**: official Anthropic SDK (streaming, cached system prompt and tools, strict tools, adaptive thinking configurable); model id only from `KORA_AI_MODEL` (no default: unset → friendly "Copilot unavailable"); provider abstraction with `anthropic`, deterministic `scripted` (reference + adversarial personas) and `replay` cassettes (test doubles refused outside dev/test); framework-free core shared with the evals.
- **Tools**: 13 read-only + `create_order_draft` / `create_strategy_draft`, strict zod schemas, server-side dispatcher (unknown names, roles, novice mode refused), every tool runs as the user. `read-ports.ts` is the only door to OMS/robots/strategies (read functions + validator); a static test and an adversarial integration test prove no order/robot/version mutation is reachable.
- **Calibration table** (`ai_predictions`, `ai_calibration_bins`): `strategy:<id>` from OOS backtest trades, `bias:<symbol>:<tf>` from the strip's rule replayed net of spread; confidence = bin hit rate with n ≥ 30, reliability line, "No edge after costs." (mean net > 0 and t ≥ 2 required for an edge).
- **Safety**: untrusted text wrapped with neutralised delimiters, PII minimised (pseudonym, redaction, PII keys stripped), numeric-fidelity / execution-claim / novice readability and suggestion guards, "Not investment advice." on every answer, audit events `ai.request` (model id, prompt hash, tokens, flags), `ai.tool_call`, `ai.draft`, `ai.draft_accepted|rejected`.
- **Budgets and metrics**: per-user / per-org daily token budgets and per-user rate limit (friendly 200 answers), response cache, Prometheus `/metrics` (tokens, cost from env prices, requests, tool outcomes, denials, latency, cache, guard flags), Grafana dashboard `infra/grafana/provisioning/dashboards/ai-copilot.json`, Prometheus scrape job.
- **Surfaces (web)**: terminal AI strip registered via `registerAiStrip` (`KORA_AI_STRIP=on`: bias, calibrated confidence, drivers ▲▼, event risk, "Draft to ticket", "Why?" with the reliability line and chat); robots copilot drawer (feature chart from `/signals/:id/features`, streamed why-answer, confidence + edge, suggestions → unapproved strategy draft → "Save as new version" by the user, no-edge scan, chat); `CopilotChat` (SSE, focused-panel context); `ExplainThis` exported for goal 08. The `/api` proxy streams SSE.
- **Evals (`services/ai-evals`)**: 80 graded cases, deterministic graders, `pnpm evals` in CI (overall ≥ 90 %, injection and refusal 100 %) — 80/80 with the scripted provider.
- **Tests**: api unit +61 (static scan, core, metrics), integration +12 (156 total, green twice), e2e +2 (41 total), web unit +4, evals 80 cases + 3 harness tests. Also fixed a goal 04 ticket preview debounce starvation (flaky e2e).

### Stubbed or placeholder

- No API key here: all runs use the scripted provider; **the live eval is pending a key** (OQ-A2, B-703). Budgets and prices are placeholders (OQ-A2).
- `ai_regime` stays `not_available` (B-701 → 07B). Live robot predictions are not yet logged into the calibration table (B-702).
- The strip's bias rule is a fixed-weight transparent score over SIMULATED data (B-708); its confidence is honest (calibrated, usually "No edge after costs" on random-walk data).

### Deferred

B-701 … B-708 (see BACKLOG); OQ-A1 (provider DPA), OQ-A2 (key, model, prices, budgets), OQ-A3 (release thresholds).

### What goals 07B and 08 need to know

- **Gateway reuse (07B):** import the core from `apps/api/src/ai/core` (`runCopilot`, `dispatchTool`, `wrapUntrusted`, guards, `calibrationView`, `buildBins`). Add tools to `TOOL_INPUTS` / `TOOL_SPECS` (roles, `novice` flag, `untrustedKeys` for article text) and implement them in `AiToolBackend`; never add a mutating tool other than a draft (ADR change). For news scoring use a separate structured-output call through the same provider abstraction (validate the JSON with zod; wrap the article with `wrapUntrusted({source: 'news', id})`), audit it as `ai.request` with the model id and prompt hash, and count tokens via `BudgetService` / `MetricsService.recordUsage`.
- **Calibration (07B):** write forecasts into `ai_predictions` **before** outcomes are known (`source: 'live'`, `model_key` e.g. `trend:<model>:<region>:<horizon>`), resolve `outcome` / `net_return` later, then `CalibrationService.rebuild(modelKey, source)`; read with `CalibrationService.view(modelKey, rawScore, minN)` → `confidence | null`, `reliabilityLine`, `edge`, `edgeStatement` ("No edge after costs." → show "No reliable signal"). `GET /ai/calibration?modelKey=` already accepts `trend:` and `news:` keys (public-data access rule).
- **Evals (07B):** add JSON cases under `services/ai-evals/src/cases/` (categories are in `harness.ts`), extend `fixtures.ts` with SIMULATED articles; graders `numeric_fidelity`, `cite`, `canary`, `prompt_integrity`, `maxGrade` are ready. Live runs: `pnpm evals:live`.
- **Novice (08):** `import { ExplainThis } from '@/components/ai'` → `<ExplainThis topic="stop loss" screenText={visibleText} />` (plain words, grade ≤ 8 checked on the server, no suggestions, no drafts; `POST /ai/explain`, any signed-in role; novice-only users are always in novice mode). Nothing in the novice routes was changed. The chat forces novice mode for novice-only accounts.
- **Ticket (04/08):** `TicketDraft.aiDraftId` (optional) carries the audited draft; the ticket records accepted/rejected after the user acts.
- **Env:** `KORA_AI_MODEL`, `ANTHROPIC_API_KEY`, `KORA_AI_PROVIDER`, `KORA_AI_THINKING`, `KORA_AI_EFFORT`, `KORA_AI_MAX_TOKENS`, `KORA_AI_MAX_TOOL_ROUNDS`, `KORA_AI_USER_DAILY_TOKENS`, `KORA_AI_ORG_DAILY_TOKENS`, `KORA_AI_RATE_PER_MIN`, `KORA_AI_ORG_ID`, `KORA_AI_CACHE_TTL_S`, `KORA_AI_CALIBRATION_MIN_N`, `KORA_AI_DRAFT_RISK_PCT`, `KORA_AI_PRICE_*`, `KORA_AI_PSEUDONYM_SALT`, `KORA_METRICS_TOKEN`, `KORA_AI_STRIP=on` (see `.env.example`). e2e sets `KORA_AI_PROVIDER=scripted`.

## Goal 07B: Market intelligence (G7B: done, with deferrals)

Plan and evidence: `docs/plans/07b-market-intelligence.md` §6. ADR 0007B (threat model additions T14–T19). Lead seats S7, S5, S2, S8. Built in parallel with goal 08 (migrations `0075–0077`).

### What shipped

- **Global coverage**: provider adapter matrix per continent (`packages/market-data/src/providers/matrix.ts`, `GET /intel/providers`), every entry a flagged, unlicensed stub with its licensing need (OQ-M3, OQ-M4); holiday + DST session tests on the seeded calendars of XNYS, XLON, XTKS, XHKG, XJSE, BVMF, XASX; radar regions = continents (+ `global` OTC); SIMULATED sector labels.
- **Scanner (`services/quant/src/kora_quant/scanner`, `POST /scanner/run`)**: 20 detectors (trend strength, regime, breakout/compression, momentum and mean-reversion z, relative strength vs sector and region, correlation break, volume/volatility anomalies, seasonality, event proximity) as numbers only; numba kernels; prefix look-ahead guard (leaky detector / injected future data → 422); incremental bar-close state; emerging-trend labels. **Benchmark**: 10,000 SIMULATED synthetic instruments × 500 one-hour bars in 10.4 s worst of 3 (budget 60 s), `bench/SCANNER_RESULTS.md`.
- **Regime model and `ai_regime`**: point-in-time volatility-clustering filter; the goal 06 condition reads it inside the backtester's guard when `aiRegime: model` (api default via `KORA_AI_REGIME=model`; `off` = goal 06 behaviour).
- **Forecasts**: walk-forward (embargo = horizon) L2 logistic per instrument × horizon (`1d/1w/1m`), isotonic/Platt calibration, skill after costs, linear SHAP drivers. Live forecasts written to `ai_predictions` at the bar close (`trend:logit:<region>:<horizon>`), resolved later from candles; OOS forecasts stored as `history_replay`; bins via `CalibrationService`. A probability is shown only with an edge after costs and a large enough bin, else **"No reliable signal"** (the normal state on SIMULATED data).
- **News**: `NewsAdapter`, SIMULATED multilingual fixtures (8 languages, duplicates, 8 injection attempts), dedup, entity linking, translation and scoring through the gateway as structured outputs (`output_config.format`, no tools, zod-validated, invalid → stored without scores), audited `ai.request` (surface `news`), budgeted.
- **API (`apps/api/src/intel`)**: `/intel/radar`, `/intel/trends/:symbol` (card), `POST /intel/trends/:symbol/explain` (grounded summary, SSE), `POST /intel/trends/:symbol/draft` (trader; audited draft, surface `radar`), `/intel/news`, `POST /intel/news/ingest` + `POST /intel/scan` (admin/quant), `/intel/alerts` (server-evaluated after every scan), `/intel/whats-moving`, `/intel/providers`, public `/intel/reliability`. Copilot tools `get_market_radar`, `get_trend_card`, `get_news`.
- **Web**: Pro `/radar` "Market Radar" (nav entry), public `/reliability`, `WhatsMovingCard` exported from `@/components/intel`, `/terminal?aiDraft=` draft loader, builder `?symbol=`.
- **Evals**: 117 cases (37 new: news injection 13, news schema 8, trend explanation 9, market radar 7), 117/117 scripted; thresholds: news injection and trend-explanation fidelity 100 %.
- **Tests**: quant 160 (36 new), market-data 71 (+11), api unit 131 (+29), api integration 168 (+12), web unit 39 (+3), e2e (+2: radar flow, public reliability).

### Stubbed or placeholder

- All market data and news are SIMULATED; every provider is a flagged stub (OQ-M3, OQ-M4). Sector labels and round-trip cost assumptions are SIMULATED (OQ-M2, OQ-M6).
- No API key here: news scoring, translations and summaries run on the scripted provider; the live eval is pending (OQ-A2, B-759).
- Regime probabilities are raw filter outputs inside backtests; calibrated regime display is B-752. Gradient boosting is B-751.

### Deferred

B-751 … B-761 (see BACKLOG); B-708 moved to goal 10; OQ-A4 (publishing the track record), OQ-M6.

### What goals 08, 09 and 10 need to know

- **Novice (08):** `import { WhatsMovingCard } from '@/components/intel'` → `<WhatsMovingCard />` on the novice Home (reads `GET /intel/whats-moving`, any signed-in role: plain words, grade ≤ 8, no suggestion, a figure only when calibrated, news source link). No novice route was edited. The `/radar` → `/home` counterpart is in `lib/modes.ts`. `POST /intel/trends/:symbol/explain` forces novice mode for novice-only accounts.
- **Risk & compliance (09):** review OQ-A4 (public `/reliability` page and novice exposure), the plain-language copy, and translations shown to users (B-756); alerts only notify (B-757 for delivery). Audit actions: `intel.scan`, `intel.alert_created|deleted`, `ai.request` (surface `news`/`radar`), `ai.draft` (surface `radar`).
- **QA/SRE (10):** scan scale-out and a true incremental kernel (B-753), Grafana panels (B-758), live-provider evals (B-759), radar visual baseline (B-761). The quant perf test runs 10,000 × 500 bars in CI (`test_scanner_perf.py`).
- **Env:** `KORA_INTEL_SCAN`, `KORA_INTEL_SCAN_CHECK_MS`, `KORA_INTEL_TIMEFRAME`, `KORA_INTEL_BARS`, `KORA_INTEL_HORIZONS`, `KORA_INTEL_MIN_TRAIN`, `KORA_INTEL_GUARD_CHECKPOINTS`, `KORA_INTEL_TIMEOUT_MS`, `KORA_INTEL_NEWS`, `KORA_INTEL_NEWS_INTERVAL_MS`, `KORA_AI_REGIME`, `KORA_NEWS_ADAPTER_*` (see `.env.example`). Integration tests and e2e run with scans and news timers off and trigger them through the API.

## Goal 08: Novice view (G8: done, with deferrals)

Plan and evidence: `docs/plans/08-novice-view.md` §6. ADR 0008. Lead seats S1, S6, S8. Built in a worktree in parallel with goal 07 (migrations `0080+`).

### What shipped

- **Guardrails (server-side, for novice-only users and anyone in the Novice view):** market + stop only; no borrowing (1×) unless the 5-question knowledge check is passed and a 24 h wait is over (cap `KORA_NOVICE_MAX_LEVERAGE`, SIMULATED 2×); loosened limits wait 24 h, tightening is immediate (`accounts.risk_limits.pending`, applied by `AccountsService.limits(account, now)`, no scheduler); cooling-off until the next UTC day after 3 losing trades, a 5 % day loss or the daily limit (`NOVICE_COOLING_OFF`); optional monthly loss limit (`MONTHLY_LOSS_LIMIT`, month snapshots). Pure rules in `@kora/domain` (`novice/*`, `trading/risk.ts`).
- **API (`apps/api/src/novice`, `apps/api/src/disclosures`):** `/novice/profile|onboarding/complete|limits|leverage|summary|assets|ticket|knowledge-check(/attempts)|auto-invest(/:id/pause|resume|go-live)`, `/disclosures/:id(/acknowledgements)`, `/sim/scenarios` (B-505), `/auth/mfa/opt-in` (B-017). Migrations `0080_novice.sql` (registry `novice_rank` + `novice_name` for 10 instruments on five continents, month snapshots, append-only `disclosure_acknowledgements`, `novice_profiles`, `robots.origin/template_id`), `0081_sim_scenarios.sql`. Knowledge check `knowledge-check.v1.json` (kind `knowledge_check`, 5 questions, 80 %, SIMULATED).
- **B-614 decision:** guarded `/novice/auto-invest` path: goal 06 templates unchanged, PAPER robot `origin = 'novice_template'`, allocation 1–25 % of the balance, 1× exposure, limits from the user's daily limit, OOS/paper results only, live always refused (audited checklist). The runner accepts a novice owner only for that origin; orders pass the novice guardrails.
- **Web:** `/onboarding` (5 screens → versioned risk warning with `[XX]%` → loss limits with suggested defaults), `/home` per `Novice.png` (balance in Fraunces, change since start, SVG area chart, worst dip, holdings in words, 3-step trade with "most you could lose" from the preview, review sheet with gain/loss scenario and the "I understand I could lose up to $X" tick, limits with pending loosenings and borrowing, cooling-off card, auto-invest and learn cards), `/auto-invest`, `/learn` (5 lessons, 13-term glossary, risks, `/learn/check`), Practice localised with saved plans and the retail-loss line (OQ-Q1), Settings (language, colours, optional two-step sign-in). EN + FR (`apps/web/src/lib/i18n`), 390 px-first, bottom tab bar, 44 px targets, installable PWA (manifest, icons, offline "prices paused" service worker, no push). "Explain this to me" slot (`lib/novice/explain-slot.tsx`, `KORA_EXPLAIN_THIS`). ESLint forbids confetti/streak/leaderboard in novice files.
- **SDK (B-506):** typed `/sim/*`, scenarios, novice, disclosure and MFA opt-in methods; sim types in `packages/sdk/src/sim-types.ts`.

### Stubbed or placeholder

- Retail-loss figure `[XX]` (OQ-R1), guardrail thresholds and suggested limits (OQ-N1, OQ-N3), borrowing cap (OQ-N2), knowledge-check content (OQ-N4) are SIMULATED placeholders. Template OOS numbers come from a best-effort SIMULATED backtest on first adoption (B-807). Cooling-off/day boundaries are UTC (B-803).

### Deferred

B-801 server-side "acknowledged before first order" gate, B-802 Pro simulator scenario UI, B-803 time zones, B-804 security/limit alerts, B-805 Lighthouse in CI, B-806 localise remaining shared screens, B-807 scheduled template backtests, B-808 human copy review sign-off, B-809 offline-navigation e2e, B-810 risk-officer view of guardrail events.

### Integrated with goals 07 and 07B (merge)

Goal 08 was built in a worktree next to goals 07 and 07B; the merge wired them together:

- **"Explain this to me":** goal 07's `ExplainThis` fills goal 08's typed slot through `lib/novice/explain-copilot.tsx` (`NoviceExplainThis`, registered once in `NoviceShell`): the typed topic becomes plain topic words, the on-screen values go as untrusted screen text, `context.panel = novice_<topic>`, labels from `explain.*` (EN/FR). Shown only in the Novice shell and with `KORA_EXPLAIN_THIS=on` (now on in `.env.example` and e2e): Home (most you could lose, cooling-off), the trade review sheet (new `spread_and_fees` slot), Learn (lessons, word list), Practice and Auto-invest. The server keeps grade ≤ 8, no suggestions, no drafts; answers are English for now and French viewers are told so (B-706).
- **"What's moving and why":** goal 07B's `WhatsMovingCard` sits on the novice Home (phones: after holdings), worded through the goal 08 i18n (`moving.*`, EN/FR, readability report updated) from new structured fields on `GET /intel/whats-moving` items (`move`, `news`, `odds`; the English strings stay), with the localised novice instrument names.
- **Novice-only accounts:** one definition, `isNoviceOnly(roles)` / `PRO_ROLES` in `@kora/domain`, now used by the OMS guardrails (`OmsService.isNovice`), the copilot and intel novice mode, and the Home onboarding redirect. A novice-only account may still look at the Pro view (goal 08 acceptance), stays guarded there, and the terminal AI strip tells it the Pro copilot needs a trader account instead of calling `GET /ai/strip` (403).
- **No gamification:** `eslint.novice.mjs` now also covers `components/ai/ExplainThis.tsx` and `components/intel/WhatsMovingCard.tsx`; the lint unit test checks them.
- **Tests added:** web unit +3 (card in French, slot adapter ×2), domain +1 (`isNoviceOnly`), api unit assertion on the structured fields, e2e +1 (explain answer on a lesson, the card in EN and FR).

### What goals 07, 09 and 10 need to know

- **Goal 07 (copilot, novice mode):** done in the merge (see above). For reference: call `registerExplainThis(Component)` once (client side) and set `KORA_EXPLAIN_THIS=on`. The component gets `ExplainSlotProps {topic: 'most_you_could_lose' | 'safety_net' | 'spread_and_fees' | 'borrowing' | 'cooling_off' | 'loss_limits' | 'robot_risk_level' | 'past_results' | 'practice_year' | 'glossary_term' | 'lesson', context: Record<string, string> (values already on screen), locale: 'en' | 'fr', mode: 'novice'}`. It must not place orders or change limits; use `useI18n()` for the viewer's language.
- **Goal 09 (disclosures):** provide `DISCLOSURE_REGISTRY` (`current(id, locale) → {id, version, locale, title, banner, body[], acknowledge, values, placeholder, simulated, reviewStatus, contentHash}`) from the Compliance-owned registry; callers (`DisclosureAcknowledgements`, the Novice banner, onboarding, Learn, Practice) stay unchanged. Acknowledgements (`disclosure_acknowledgements`: user, id, version, content hash, rendered values, locale, context, time; audit `disclosure.acknowledged`) are bound to the exact rendered text; a new version or figure means everyone acknowledges again. Add the server-side first-order gate (B-801).
- **Goal 09 (questionnaires / suitability):** the engine now holds `appropriateness` v1 and `knowledge-check` v1; add `suitability` the same way (`QUESTIONNAIRE_FILES`). `QuestionnaireService.record(c, user, def, grade, at?)` takes an optional app-clock time. Knowledge-check status: `NoviceService.knowledgeStatus(userId)`; audit `knowledge_check.passed|failed`.
- **Goal 09 (limits):** guarded loosening lives in `@kora/domain` `applyLimitChanges/effectiveOwnLimits/pendingChanges`; Pro loosening policy (OQ-R5) can reuse it by passing a delay. Audit `account.settings_updated` carries `{guarded, limitsApplied, limitsPending}`.
- **Env:** `KORA_DISCLOSURE_RETAIL_LOSS_PCT`, `KORA_NOVICE_*`, `KORA_RISK_MONTHLY_LOSS_LIMIT`, `KORA_EXPLAIN_THIS` (see `.env.example`). e2e helpers: `apiSignIn(page, 'novice')` now completes onboarding through the API (`{onboarded: false}` to skip); `apiOnboard(request)`.

## Goal 09: Risk, compliance and governance (G9: done, with deferrals)

Plan and evidence: `docs/plans/09-governance.md` §6. ADR 0009. Lead seats S8, S9, S3. Migrations
`0090`–`0092`. Nothing here is legal advice; every regulatory value stays a placeholder with an owner.

### What shipped

- **Control framework:** 31 controls in code (`apps/api/src/governance/controls/catalogue.ts`) covering
  access/MFA, segregation of duties, change management, audit-log integrity, pre-trade risk,
  reconciliation, AI oversight, retention/data protection, incidents, backup/restore, compliance hooks
  and independent assurance; COBIT 2019 references, owner line 1/2/3, frequency, nature, test
  procedure; `docs/governance/control-matrix.md` + `.xlsx` generated (drift test). Each control has an
  implemented evidence query; `GET /governance/controls/{id}/evidence?from&to&format=json|csv|pdf`,
  audited with the file's SHA-256.
- **Three lines of defence:** new role `auditor` (read-only, MFA, SoD: no operating role; API + trigger).
  `docs/governance/three-lines.md`.
- **Four-eyes engine** (`four_eyes_requests`, API + trigger): limit overrides above the platform
  default (`accounts.limit_overrides`), resume after a firm halt, MFA reset (B-003), disclosure
  publication; robot promotion keeps the goal 06 sign-off. Approver ≠ requester ≠ person concerned.
- **Kill switch:** firm-wide kill switch on the console (B-314); firm halts need two people to resume
  (`KORA_FOUR_EYES_RESUME=firm|all`); every activation raises a `kill_switch.fired` alert.
- **Risk officer console** `/risk`: exposure and loss vs limits (goal 03 valuations), limit breaches,
  robots near auto-pause (goal 06 supervisor inputs), pending approvals, kill-switch history,
  reconciliation breaks, AI draft rates, novice guardrail events (B-810), open incidents, evidence
  export; live alerts on WS `risk:alerts` via `pg_notify` → Redis (breach → screen ≈ 60 ms; budget 5 s).
- **Internal audit view** `/internal-audit`: read-only events, chain verification, ES256-signed audit
  anchors (B-007), seeded reproducible sampling per control, CSV exports.
- **Compliance hooks:** DB disclosures registry (versioned, per jurisdiction, effective dates,
  placeholder values, four-eyes publication) behind the goal 08 interface; acknowledgement history with
  the re-rendered, hash-verified text; first-order gate `DISCLOSURE_NOT_ACKNOWLEDGED` (B-801);
  suitability questionnaire on the goal 03 engine; KYC stub; best-execution data; retention policy and
  dry-run report; subject-access export.
- **Operations:** runbooks for feed outage, engine stall, reconciliation break, AI provider outage,
  kill switch fired, database restore; SLOs (proposed); ITIL 4 incident workflow + register (P1/P2
  close only with a review); post-incident review template; tabletop "kill switch fired +
  reconciliation break" exercised on the local stack with evidence; `scripts/backup.sh` (backup +
  restore test → `backup_runs`); release record (`system.release_started`).
- **Also:** B-014 generic sign-up, B-202 minor-unit quotes (HSBA.XLON in GBX), B-203 WS quotas and token
  refresh, B-303 owners see system events about their account, TLS to Postgres/Redis enforced outside
  dev/test, `docs/governance/data-protection.md`.

### Stubbed or placeholder

- Regulatory values: retail-loss figure `[XX]` (OQ-R1), retention periods (OQ-R4), suitability content
  and bands (OQ-C2), KYC provider (OQ-K1), personal-data retention and subject-access rules (OQ-P1,
  OQ-P2), SLO targets (OQ-O1), notification duties (OQ-O2), best-execution policy (OQ-X1), COBIT
  references to confirm (OQ-G1), four-eyes parameters (OQ-G2), console thresholds (OQ-G3).
- KYC is a flagged stub; anchors go to a JSON-lines file (object-lock storage is B-903).

### Deferred

B-002 (→ 10 with Keycloak), B-003 recovery codes (B-902), B-204 (Sponsor data), B-307 (OQ-B3), B-308 /
B-803 (time zones), B-310, B-403, B-605, B-606, B-702, B-756, B-757, B-804, B-806, and the new B-901 …
B-916 (see BACKLOG).

### What goal 10 needs to know

- **Gate additions:** the integration suite now includes `governance-four-eyes`, `governance-evidence`,
  `risk-console`, `internal-audit`, `compliance`, `ws-quotas`, `minor-units`; e2e adds
  `governance.spec.ts`. Novice test users must acknowledge the risk warning before trading
  (`acknowledgeRiskWarning()` in `apps/api/test/helpers.ts`; e2e `apiSignIn` already onboards).
- **Security review targets (S9):** four-eyes engine and triggers, the `auditor` SoD, evidence export
  (CSV injection neutralised, PDF writer), subject-access export (no secrets), `risk:alerts` channel
  authorisation, WS quotas, TLS enforcement, anchor key handling (`KORA_AUDIT_ANCHOR_JWK` required
  outside dev/test), B-014.
- **Observability (S10):** relay counters on `GET /risk-console/alerts` (`relay`), release record events,
  `backup_runs`, SLO list in `docs/runbooks/slos.md` → dashboards and alerts (B-916, B-012); page on-call
  for critical alerts (B-908).
- **Release:** set `KORA_BUILD_SHA` and `KORA_RELEASE_APPROVAL_REF` in the pipeline (control KC-11);
  schedule `scripts/backup.sh` (or managed PITR + monthly restore test) and the daily anchor job
  (`KORA_AUDIT_ANCHOR_INTERVAL_MS=86400000`, object-lock storage B-903).
- **Env:** `KORA_FOUR_EYES_*`, `KORA_RISK_NEAR_*`, `KORA_AUDIT_ANCHOR_*`, `KORA_JURISDICTION`,
  `KORA_BUILD_SHA`, `KORA_RELEASE_*`, `KORA_ALERT_RELAY`, `KORA_RETENTION_<CLASS>_DAYS`,
  `KORA_SUITABILITY_BANDS`, `KORA_MD_WS_MAX_CONN_PER_*`, `KORA_ALLOW_INSECURE_TRANSPORT` (see
  `.env.example`).
