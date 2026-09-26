# Plan 02 — Market data service

Lead seats: S3 (architect), S4 (trading-systems engineer). Gate lenses: S8, S9, S10.
Status: **in progress** (plan written before implementation; §6 and §7 are filled in at verification).

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
- Conflation: per channel, at most 10 sends in any 1000 ms window; the latest value is held and flushed when the
  window frees (never dropped at the end). Depth is published as top-N snapshots, so conflation is lossless for state.
- Slow consumers: skip a frame when `bufferedAmount` > 1 MiB, close with 1013 above 8 MiB.

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

To be filled at verification.
