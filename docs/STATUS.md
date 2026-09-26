# KORA — delivery status

Last updated: 2026-09-26 (goal 04 done; goal 03 done; goals 02 and 05 merged earlier).

| Gate | Goal | State |
|---|---|---|
| G0 | 00 master plan | **Done**: `docs/plans/00-master.md`, ADR 0000/0001, charter |
| G1 | 01 foundation | **Done, with deferrals**: see `docs/plans/01-foundation.md` §4 and §6 |
| G2 | 02 market data | **Done, with deferrals**: see `docs/plans/02-market-data.md` §7 and §8 |
| G3 | 03 OMS, paper engine, risk, kill switch (+ B-018 appropriateness, B-501) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/03-oms.md` §6 (deferred items in §6.3) |
| G4 | 04 Pro terminal UI (+ B-009, B-011, B-208, B-210, B-305) | **Done, with deferrals**: every acceptance criterion passes, see `docs/plans/04-pro-terminal.md` §6 (deferred items in §6.5) |
| G5 | 05 gain simulator | **Done, with deferrals**: see `docs/plans/05-gain-simulator.md` (paper import now uses real fills, B-501 done in goal 03; human copy review owed) |

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

