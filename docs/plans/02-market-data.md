# Plan 02 — Market data service

Lead seats: S3 (architect), S4 (trading-systems engineer). Gate lenses: S8, S9, S10.
Status: **G2 passed** (all six acceptance criteria met; deferrals in §8). Verified 2026-09-26 in the cloud build environment: 4 vCPU, no Docker, native Postgres 16 (no TimescaleDB) and Redis 7, Node 22.22.

## 1. Design summary

```
                        ┌──────────────────────── apps/api (one process in dev, or split) ───────────────────────┐
 SimulatedAdapter ─┐    │  FeedService (MarketDataFeedModule)                  MarketDataGateway (/ws)            │
 broker-fxcfd stub ├──► │   gap detector → resync ─► Redis PUBLISH kora:md:* ─► ref-counted SUBSCRIBE ─► conflate │──► SDK MarketDataSocket
 crypto-testnet stub│   │   staleness monitor → status      last-value SET          (≤ 10 msg/s/channel)          │    (reconnect, resubscribe, backoff)
 equities stub  ───┘    │   1 s bar builder → md_trades, md_bars_1s ─► md_refresh_candles() ─► md_candles          │
                        │   history backfill → md_candles_history          REST: /instruments /candles /quotes …   │
                        └───────────────────────────────────────────────────────────────────────────────────────┘
```

- **Registry is the only source of precision.** `instruments` (DB) is loaded at start; every adapter and the API
  round prices with the instrument's `tick_size`/`price_precision` and quantities with `qty_step`/`qty_precision`.
- **Feed and gateway only meet through Redis.** `KORA_MD_FEED=inprocess` (dev, tests) runs the feed inside the api
  process; `KORA_MD_FEED=off` plus `pnpm --filter @kora/api md:feed` runs it as its own process. The code path is the
  same (Redis pub/sub + last-value keys), so the gateway can scale separately.
- **Global-ready registry (sponsor scope update, 2026-09-26).** Instruments link to a `venues` table (ISO 10383 MIC,
  country ISO 3166-1, region/continent, IANA timezone, trading currency, session calendar as data: weekly sessions
  with lunch breaks, holidays and early closes, status). Instruments carry nullable ISIN/FIGI identifiers, an
  `asset_class` from the extended list (equity, etf, bond, future, option, fx, metal, energy, agri, crypto, index,
  cfd, fund) and an optional `underlying_class` (US500 = `cfd` on `index`). Session status (`open | break | closed |
  holiday`, next change) is computed from venue timezone + calendar in `@kora/domain` and tested across DST for
  XNYS, XLON, XTKS, XHKG, XJSE, BVMF and XASX. The simulator generates for **any** registry instrument (asset-class
  default profile when no explicit one exists). Real providers stay flagged stubs.
- **Deterministic simulator.** Seeded PRNG (xoshiro128**), one independent stream per symbol, virtual clock of
  100 ms steps. Output depends only on `(seed, startTs, instrument specs, start prices, calendar)`.

## 2. Files

| Area | Path | Notes |
|---|---|---|
| Sessions | `packages/domain/src/sessions.ts` | Pure session-status computation from IANA timezone + calendar data (Intl, no tz library). |
| Wire schema | `packages/domain/src/market-data.ts` | Quote, Trade, DepthSnapshot, DepthDelta, Candle, FeedStatus, CalendarEvent (zod + types), timeframes, channel names. Shared by api, SDK and web. |
| Engine library | `packages/market-data` (new) | `prng`, `SimulatedMarket` (GBM + regime switching + spreads + depth + trades + event shocks), `SimulatedAdapter`, `MarketDataAdapter` interface, `SeqGapDetector`, `OrderBook`, `BarBuilder`/`aggregateBars`, `Conflator` (sliding window), `precision` helpers, `SimulatedCalendarProvider`, seed catalog `SEED_INSTRUMENTS`, stub adapters + hand-crafted fixtures + contract suite. |
| Migration | `apps/api/migrations/0002_market_data.sql` | `asset_classes`, `instruments` (+31 SIMULATED seeds), `md_trades`, `md_bars_1s`, `md_candles`, `md_candles_history`, `md_refresh_candles()`, `md_apply_retention()`, Timescale guard. |
| API module | `apps/api/src/market-data/*` | `InstrumentsRepository`, `FeedService`, `CandlesService`, `MarketDataGateway`, `ChannelHub`, controllers, `feed-cli.ts`. |
| SDK | `packages/sdk/src/market-data-socket.ts` | Typed WS client: auth op, auto-reconnect, exponential backoff with jitter, resubscribe, heartbeat. REST methods for instruments/candles/quotes/depth/status/calendar. |
| Load test | `apps/api/load/ws-fanout.mjs` (+ `ws-fanout.k6.js` reference) | Node generator (see §5). |
| Web (cheap wiring) | `apps/web/src/components/terminal/Watchlist.tsx` | Live quotes via the SDK with a STALE badge; the full terminal is goal 04. |
| Docs | this plan, `docs/adr/0002-market-data.md`, `docs/STATUS.md`, `docs/open-questions.md` | |

## 3. Schema (migration 0002)

- `asset_classes(asset_class PK, label, stale_after_ms)`: fx/metal/crypto 2000 ms; equity, etf, bond, future, option,
  energy, agri, index, cfd 5000 ms; fund 3 600 000 ms (NAV-priced).
- `venues(mic PK, iso_mic, operating_mic, name, country, region, timezone, currency, calendar jsonb, calendar_source,
  status, simulated)`: SIMULATED sample set covering every continent — XNYS, XNAS, ARCX, XCME, XTSE (North America);
  BVMF (South America); XLON, XETR, XPAR (Europe); XTKS, XHKG, XSHG, XNSE (Asia); XJSE (Africa); XASX, XNZE (Oceania);
  plus two non-ISO simulated OTC venues `KSIM` (FX/CFD, 24/5 New York convention) and `KCRY` (crypto, 24/7).
  Holidays are a small sample, not an authoritative calendar (OQ-M2).
- `instruments`: `symbol` PK, `display_name`, `venue` FK, `venue_symbol`, `isin`, `figi` (nullable, format CHECKs),
  `asset_class` FK, `underlying_class`, `base_ccy`, `quote_ccy`, `tick_size numeric`,
  `price_precision`, `pip_size numeric`, `contract_size numeric`, `min_qty numeric`, `qty_step numeric`,
  `qty_precision`, `trading_sessions jsonb`, `margin_rates jsonb` (by tier), `fee_schedule_id`, `status`
  (`active|halted|delisted`), `venue` (`SIM`), `simulated boolean`. CHECKs: tick > 0, tick has ≤ price_precision
  decimals, qty_step divides into qty_precision. Margin rates are **placeholders** (OQ-M1).
- `md_trades(symbol, ts, trade_id, source, seq, price, qty, side)`, PK `(symbol, ts, trade_id)`.
- `md_bars_1s(symbol, ts, open, high, low, close, volume, trades)`, PK `(symbol, ts)`.
- `md_candles(symbol, tf, bucket, …)`: continuous-aggregate emulation, derived only from `md_bars_1s`
  hierarchically (1s→1m→5m→15m→1h→4h→1D) by `md_refresh_candles(p_from)`; buckets via `date_bin` with UTC origin.
- `md_candles_history`: simulated backfill before the first live bar. `/candles` merges both per bucket
  (open from the earlier source, close from the later, max/min, sum).
- Retention (`md_apply_retention()`, hourly): trades 7 d, 1 s bars 7 d, 1m candles 90 d.
- TimescaleDB: when the extension exists, `md_trades` and `md_bars_1s` become hypertables with retention policies.
  It does not exist here, so plain tables are used and true continuous aggregates are deferred (§7).

## 4. Wire protocol

- Client → server: `{op:'auth', token}` (non-browser; browsers use the `kora_at` cookie + Origin check),
  `{op:'subscribe'|'unsubscribe', channels:[…], id?}`, `{op:'ping'}`.
- Server → client: `{type:'welcome'}`, `{type:'subscribed'|'unsubscribed', channels, id}`, `{type:'error', code, message}`,
  `{ch:'quotes:EURUSD', data:Quote, snapshot?:true}`, `{type:'pong'}`.
- Channels: `quotes:{symbol}`, `depth:{symbol}`, `candles:{symbol}:{tf}`, `status`. Every data message carries
  `source`, `exchangeTs`, `receivedTs`, `seq` (epoch ms integers; prices and sizes are decimal strings).
- Conflation: per channel token bucket, 10 updates/s sustained with a burst of 2 (≤ 12 in any single second); above
  the rate only the latest value is held and sent when a token frees, so the final value is never lost. (A strict
  sliding "10 per second" window was built first and measured: fed at exactly 10 Hz it echoes every jitter/GC delay
  forward and added ~16 ms median delay under load; see §7.3.) Depth is published as top-N snapshots, so conflation
  is lossless for book state. Snapshots sent on subscribe are per client and outside the bucket.
- Fan-out: each frame is built once as raw RFC 6455 bytes and written to every subscriber socket, corked so each
  client gets one `writev` per event-loop turn (`KORA_MD_WS_FLUSH_MS` adds an optional coalescing window).
- Slow consumers: skip a frame when `bufferedAmount` > 1 MiB, close with 1013 above 8 MiB.
- Status: `ok | degraded` from the feed (any adapter down/resyncing or stale symbol → `degraded`); `down` only when
  the gateway loses the feed heartbeat for 2.5 s (feed process gone), in which case it re-sends quotes `stale:true`.

## 5. Test plan (maps to acceptance criteria)

| # | Criterion | Test |
|---|---|---|
| 1 | Same seed → identical sequence | `packages/market-data/src/sim/simulated-market.test.ts`: committed vitest snapshot of 2 000 steps × 4 instruments, rerun equality, different seed differs. |
| 2 | `/candles` p95 < 150 ms, correct OHLCV | Unit: `aggregateBars` vs hand-computed bars. Integration: `candles.int.test.ts` inserts hand-crafted 1 s bars, runs `md_refresh_candles`, checks 1m/5m/15m against hand-computed values; seeds 5 000 × 15m candles and measures p95 over 200 requests. |
| 3 | 200 symbols × 10 msg/s to 500 clients, p99 fan-out < 50 ms | `apps/api/load/ws-fanout.mjs`: api (feed off) + Redis publisher of 200 symbols at 10 Hz + 500 WS clients in worker threads; latency = client receive − publish time. k6 binary download is blocked by the proxy (HTTP 403 on GitHub releases), so the Node generator is the executed tool; a k6 script is committed for Docker/CI. |
| 4 | Kill adapter → `degraded` ≤ 3 s, `stale:true`; restart → gap resync | `feed-resilience.int.test.ts` over a real WS: stop via `POST /market-data/feeds/simulated/stop` (admin, audited), measure time to `status.state='degraded'` and a `stale:true` quote; start → `resync` recorded with `{expected, got}` and status back to `ok`. |
| 5 | Precision/tick from registry (fast-check) | `precision.property.test.ts`: arbitrary instrument specs (ticks like 0.00001, 0.25, 5) × seeds → every price is a tick multiple with exactly `price_precision` decimals, sizes on `qty_step` ≥ `min_qty`, ask > bid, depth sorted. Plus a source scan that forbids literal `toFixed(<n>)` in market-data code, and a DB-vs-catalog drift test. |
| + | Sessions across DST (scope update) | `packages/domain/src/sessions.test.ts`: fixed instants either side of US/UK/AU/BR DST changes and lunch breaks for XNYS, XLON, XTKS, XHKG, XJSE, BVMF, XASX, plus holidays and early closes. |
| 6 | ADR + STATUS | `docs/adr/0002-market-data.md`, `docs/STATUS.md`. |

Also: gap detector, order book, conflator and aggregation properties (fast-check); adapter contract suite on
hand-crafted fixtures for each stub; SDK reconnect/backoff/resubscribe with a fake socket; gateway auth, Origin
check, channel validation and ref-counting.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Floats leak into prices | Floats stay inside the simulator; one conversion point (`floatToTick`) rounds to the registry tick and emits strings; property test. |
| Float maths differs across platforms (snapshot) | V8's `Math.log/exp/cos` are deterministic per Node major; snapshot pinned to Node 22 (documented). |
| Egress on 4 cores | Frames serialised once per channel into a Buffer, per-message deflate off, backpressure checks. |
| Staleness when the whole feed process dies | Gateway watches the feed heartbeat and synthesises `degraded` + stale quotes on its own. |
| Timescale absent | Plain tables + hierarchical rollup function with identical semantics; hypertable DDL guarded. |
| Margin tiers / sessions look regulatory | Seeded as SIMULATED placeholders, logged in `open-questions.md`. |

## 7. Results

### 7.1 Acceptance criteria (Project Owner tick sheet)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Same seed → identical sequence (snapshot test) | **Pass** | `simulated-market.test.ts`: committed snapshot (SHA-256 digest of 2 000 steps × EURUSD/XAUUSD/BTCUSD/7203.XTKS with a US CPI shock, first/last quotes, counts 8 000 quotes / 8 000 depth / 2 393 trades); same seed twice identical; different seed differs; per-symbol streams independent of the instrument set. |
| 2 | `GET /candles?symbol=EURUSD&tf=15m&limit=500` < 150 ms p95 locally, correct OHLCV vs hand-computed bars | **Pass** | `candles.int.test.ts`: nine hand-crafted 1 s bars through the SQL rollup equal hand-computed 1m/5m/15m/1h/4h/1D bars; idempotent refresh + late bar; history/live bucket merge; registry precision (`1.0831` → `1.08310`). Latency over 200 sequential requests (after 20 warm-up) on 5 000 history + 1 000 live 15m candles: **p50 11.9 ms, p95 18.4 ms, p99 20.5 ms**. Unit + fast-check: `bars.test.ts` (hierarchical = direct aggregation, invariants, volume conservation). |
| 3 | 200 symbols × 10 msg/s to 500 clients, p99 fan-out < 50 ms (script + results committed) | **Pass** | `apps/api/load/ws-fanout.mjs` (Node generator; k6 blocked by the proxy, reference `ws-fanout.k6.js` committed). 500 clients × 20 of 200 symbols, 60 s: **p99 13.1 ms** (p50 3.0, p95 8.8, max 38.5), 6.0 M frames at 99 987/s, 99.99 % delivered, 0 errors. Results in `apps/api/load/results/*.json`; table in §7.3. |
| 4 | Kill adapter → `status` `degraded` within 3 s, quotes `stale:true`; restart → gap resync (integration test) | **Pass** | `feed-resilience.int.test.ts` over a real WebSocket: admin `POST /market-data/feeds/simulated/stop` (audited, trader gets 403) → `degraded` and EURUSD `stale:true` after **7 ms**; REST `/quotes` also stale; restart → first quote seq jumps (missed steps never delivered), gap recorded `{expected, got}`, resync from snapshot, `resyncs ≥ 1`, status back to `ok`, no stale symbols. Also a silent-stall drill: FX stale after **2.19 s**, equity after **5.20 s** (per-asset-class thresholds), while the adapter stays `up`. Gateway heartbeat loss → `down` + stale quotes (`ws-gateway.int.test.ts`). |
| 5 | Precision and tick rounding from the registry, never hard-coded (fast-check) | **Pass** | `precision.property.test.ts`: 150 arbitrary registry rows (ticks 0.00001…5, 0.25, 0.0025, 0.015625; extra precision; qty steps) × seeds → every bid/ask/depth/trade price is a tick multiple with exactly `price_precision` decimals, sizes on the qty grid ≥ min qty, ask > bid, depth sorted; rounding helpers property-tested; a source scan forbids literal `toFixed(<n>)`/`toDecimalPlaces(<n>)`; DB CHECKs (tick fits precision, step fits qty precision); registry drift test DB = catalog; stub adapters round vendor JSON numbers through the registry (`118.915` → `118.92`). |
| 6 | `docs/adr/0002-market-data.md` and STATUS written | **Pass** | ADR 0002, this plan, `docs/STATUS.md`, BACKLOG B-201…B-210, OQ-M1/OQ-M2. |
| + | Sponsor scope update: global registry, sessions across DST | **Pass** | `venues` (19, all continents), extended asset classes (13, each seeded), ISIN (check digits verified)/FIGI, aliases; `sessions.test.ts` + `seed.test.ts`: XNYS, XLON, XTKS, XHKG, XJSE, BVMF, XASX across DST, lunch breaks, holidays, early closes, XCME maintenance break, FX 24×5, crypto 24/7; simulator runs every registry row. |

### 7.2 Verification log (pasted)

```
$ pnpm lint        →  Tasks: 12 successful, 12 total
$ pnpm typecheck   →  Tasks: 12 successful, 12 total
$ pnpm test --force →  Tasks: 12 successful, 12 total
  @kora/domain       Tests 39 passed   (sessions 13, market-data schema 4)  coverage lines 100% / branches 97.9%
  @kora/market-data  Tests 60 passed   coverage lines 99.2% / branches 91.9%
  @kora/sdk          Tests 10 passed   coverage lines 97.6%
  @kora/api (unit)   Tests 29 passed
  @kora/web          Tests 7 passed
  @kora/ui           Tests 113 passed
  @kora/bot-runner   Tests 5 passed
  @kora/quant        11 passed, coverage 90.91%
$ pnpm --filter @kora/api test:integration   (real Postgres 16 + Redis 7)
  ✓ test/ws-gateway.int.test.ts (8 tests)
  ✓ test/feed-resilience.int.test.ts (3 tests)
      [resilience] degraded after 7 ms, stale after 7 ms
      [stall] FX stale after 2190 ms, equity stale after 5195 ms
  ✓ test/candles.int.test.ts (10 tests)
      [candles latency ms] {"n":200,"p50":11.9,"p95":18.4,"p99":20.5,"max":21.9}
  ✓ test/market-data-registry.int.test.ts (5 tests)
  ✓ auth (9) · audit (7) · preferences-killswitch (6) · lockout (1) · health (2)
  Tests 51 passed (51)
$ pnpm --filter @kora/web build && pnpm test:e2e   (api :4010 with in-process SIMULATED feed, next start :3010)
  ✓ 14 market-data › pro terminal watchlist streams SIMULATED quotes over the WebSocket with registry precision
  ✓ a11y (4, incl. /terminal with the live watchlist) · auth (4) · kill-switch (5) · mode (1) · rbac (2)
  17 passed
$ pnpm --filter @kora/api load:ws -- --clients 500 --symbols 200 --rate 10 --per-client 20 --duration 60 --warmup 10
  [load] 500 clients connected and subscribed in 1.1 s; warming up 10 s
  "received": 6007142, "deliveredRatio": 0.9999, "egressPerSec": 99987,
  "latencyMs": { "mean": 3.66, "p50": 3, "p95": 8.8, "p99": 13.1, "max": 38.54 },
  "gateway": { "cpuPercent": 85.2, "rssMb": 287, "channels": 200, "subscriptions": 10000, "dropped": 0, "slowClosed": 0 },
  "loadGenerator": { "clientWorkerEventLoopUtilization": [0.33, 0.34, 0.33] }
  [load] p99 fan-out latency 13.1 ms → PASS (< 50 ms)
```

### 7.3 Load test: method, interpretation and tuning history

- **Interpretation.** "200 symbols × 10 msg/s to 500 clients" = 2 000 msg/s ingress on 200 channels; each of the 500
  clients subscribes to a 20-symbol watchlist (10 000 subscriptions, 100 000 frames/s egress). A stress profile with
  40 symbols per client (200 000 frames/s) was also run. Every process (api, Redis, publisher, 3 client worker
  threads) shares one 4-vCPU host, so these numbers are conservative.
- **Latency** = client receive time − publisher timestamp taken just before `PUBLISH` (same host clock,
  `performance.timeOrigin + performance.now()`), so it covers Redis, the gateway, conflation and the socket.
- **Tool.** k6 cannot be installed here (proxy HTTP 403 on GitHub release assets); artillery's WS engine cannot read
  a per-message server timestamp without a custom processor. `ws-fanout.mjs` uses worker threads and the `ws` client;
  `ws-fanout.k6.js` is the same scenario for CI/Docker (`--clients 0` runs api + publisher only).

| Profile (500 clients, 200 symbols × 10 Hz) | Egress/s | p50 | p95 | p99 | max | Gateway CPU | Result |
|---|---|---|---|---|---|---|---|
| 20 symbols/client, flush 0 (default), 60 s | 99 987 | 3.0 | 8.8 | **13.1** | 38.5 | 85 % | Pass |
| 20 symbols/client, flush 5 ms, 30 s | 100 009 | 8.9 | 14.4 | 16.9 | 29.3 | 60 % | Pass |
| 40 symbols/client (stress), flush 0, 30 s | 199 985 | 4.2 | 10.5 | 13.3 | 27.1 | 94 % | Pass |
| 40 symbols/client (stress), flush 5 ms, 30 s | 199 969 | 8.7 | 15.0 | 17.7 | 25.4 | 61 % | Pass |

Tuning history (20 symbols/client), each step measured, profiled or instrumented:

1. First build, `ws.send` per client per frame, sliding-window conflation: **p99 1 422 ms**, gateway 99 % CPU, 90 % delivered.
2. Pre-built frames written to corked sockets: p99 99 ms. A CPU profile showed 65 % of gateway time in native
   `writeBuffer`/`writev` (one syscall per frame per client on loopback).
3. Uncork per event-loop turn (+ cheaper client parsing): p99 64 ms, clients at 0.33 event-loop utilisation, so
   the gateway was still the bottleneck.
4. A coalescing window cut CPU to 46–58 % but latency *rose*. Instrumentation showed Redis→gateway p50 1.3 ms but
   conflator exit p50 16 ms: the strict sliding window fed at exactly 10 Hz echoed every delay forward.
5. Token-bucket conflation (10/s, burst 2): **p99 13–17 ms** at 100 k and 200 k frames/s.

## 8. Deferred with reason

| Item | Reason | Backlog |
|---|---|---|
| TimescaleDB hypertables, continuous aggregates, retention policies | Extension not available here; guarded DDL is untested. Plain tables + `md_refresh_candles` hierarchical rollup + `md_apply_retention` have the same semantics. | B-201 |
| k6/artillery execution | Proxy blocks the k6 binary; Node generator executed instead, k6 script committed. | B-207 |
| Real broker/exchange/equities transports | No contracts or keys (sponsor). Decoders, subscription encoders and contract tests on hand-crafted fixtures are done. | B-205, OQ-B1/B2 |
| Authoritative venue calendars, holiday lists, tick-size bands, GBX/ZAc minor units | Licensed reference data needed; sample calendars are labelled SIMULATED. | B-202, B-204, OQ-M2 |
| Margin rates by tier | Regulatory values; seeded as placeholders. | OQ-M1 (with OQ-R3) |
| Full terminal (chart, order book, calendar panels, trades tape) | Goal 04; goal 02 wires the watchlist only. | B-210 |

## 9. Gate review notes (S8 / S9 / S10)

- **S9 (security):** WS auth by cookie + Origin allow-list (CSWSH) or `auth` op; global MFA rule; close on token
  expiry; 5 s auth timeout; op rate limit; channel cap; payload cap 16 KiB; slow-consumer eviction; feed control
  endpoints admin-only and audited; stub adapters cannot reach the network (live transport refuses); fixtures scanned
  for secret-like keys; Redis namespace per environment; CSP `connect-src` limited to the api `/ws` on the page host
  (Host header sanitised). Findings: B-203 (per-user connection quotas, WS re-auth).
- **S8 (risk):** every quote carries `stale`, and `status` distinguishes degraded vs down, which goal 03 must enforce
  before fills. All data SIMULATED (registry flag, `source`, UI caption "Simulated feed · not market data"); margin
  tiers placeholder (OQ-M1).
- **S10 (quality):** pyramid in place (unit + fast-check → integration on real Postgres/Redis/WS → e2e → load);
  two real bugs found by tests (channel-cap counting, subscribe/close race leak) and one design flaw found by the load
  test (sliding-window echo), all fixed with regression tests.
