# KORA — delivery status

Last updated: 2026-09-26 (end of goal 02).

| Gate | Goal | State |
|---|---|---|
| G0 | 00 master plan | **Done**: `docs/plans/00-master.md`, ADR 0000/0001, charter |
| G1 | 01 foundation | **Done, with deferrals**: see `docs/plans/01-foundation.md` §4 and §6 |
| G2 | 02 market data | **Done, with deferrals**: see `docs/plans/02-market-data.md` §7 and §8 |

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

- Account summary values, watchlist, chart, order preview numbers and blotter are shown as "—" or as "arrives in goal NN".
- The kill switch records intent only (`engine: not_wired_goal_03`).
- The robot builder, simulator, practice, auto-invest and learn pages are placeholders.
- The command palette is an entry point only.

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
  - `createUser(app, 'novice' | 'trader', extraRoles?)` signs up, logs in and does TOTP enrolment/verify, then returns a bearer token.
  - `nextTotpWindow()` advances the faked `Date` 31 s, so repeated logins don't hit TOTP replay protection.
  - Extra roles are granted with a direct owner SQL insert.
  - Send `x-kora-csrf: 1` on unsafe requests unless you use `Authorization: Bearer`.
  - e2e uses `apiSignIn(page, type)` in `apps/web/e2e/helpers.ts`.
- **Decimals:** `import { dec, quantize, roundToTick, Decimal } from '@kora/domain'`. `dec(0.1)` throws by design. The UI formats via `formatPrice(value, precision)` and `formatMoney` from `@kora/ui`.
- **Kill switch:** the web calls `POST /kill-switch {scope, source}` with scopes `robots | robots_cancel | robots_cancel_flatten`. Goal 03 replaces the intent-only handler with the engine and audits each child action.
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
