# ADR 0002 — Market data layer

- Status: Accepted (2026-09-26)
- Deciders: S3 (architect, lead), S4 (trading-systems engineer, lead), S8, S9, S10, Project Owner
- Context: goal 02, plus the sponsor's scope update of 2026-09-26 (global-ready registry: every asset class, every continent, any exchange).

## Decision

### 1. One registry, global from day one

- `venues`: ISO 10383 MIC (`iso_mic=false` for KORA's simulated OTC venues `KSIM`, `KCRY`), operating MIC, name, ISO 3166-1 country, region (`africa | asia | europe | north_america | south_america | oceania | global`), IANA timezone (validated against `pg_timezone_names` by trigger), ISO 4217 trading currency, **session calendar as data** (`weekly` local-time ranges, where two ranges on one day are a lunch break; `holidays`; `earlyCloses`), calendar source, status.
- `instruments`: symbol (internal code, `^[A-Z0-9][A-Z0-9._-]{0,31}$`, e.g. `EURUSD`, `7203.XTKS`), venue FK, venue symbol, nullable ISIN (check digit tested) and FIGI, asset class from `equity, etf, bond, future, option, fx, metal, energy, agri, crypto, index, cfd, fund` plus optional `underlying_class` (US500 = `cfd` on `index`), base (nullable) and quote currency, tick size, price precision, pip size, contract size, min qty, qty step, qty precision, optional instrument-level session override (with its own timezone), margin rates by tier (**placeholders**, OQ-M1), fee schedule id, status. DB CHECKs enforce that the tick fits the precision and the qty step fits the qty precision.
- `asset_classes` holds the stale thresholds (FX/metal/crypto 2 s, most others 5 s, funds 1 h).
- `instrument_aliases(source, vendor_symbol, symbol)` maps any provider's naming onto the registry.
- The TypeScript catalog (`packages/market-data/src/seed`) is the single source of the SIMULATED seed; migration 0002 was generated from it and an integration test fails on drift.
- **Precision is never a literal.** Every price/qty leaving the market data layer goes through `formatPrice/formatQty/formatSize/formatVolume` with the registry row. A fast-check property drives the simulator with arbitrary specs (ticks such as 0.25, 5, 0.015625) and a source scan forbids literal `toFixed(<n>)`.

### 2. Sessions are computed, not stored

`sessionStatus(calendar, timezone, instant)` in `@kora/domain` returns `open | break | closed | holiday` and the next change. It works in venue-local wall time through `Intl` (full ICU ships with Node 22), so DST needs no table. Tested across US, UK, Australian and (absent) Brazilian DST changes, the XTKS/XHKG lunch breaks, holidays, early closes, the FX 24×5 New York convention and 24/7 crypto. The browser can run the same function.

### 3. Adapter interface and normalised schema

`MarketDataAdapter { connect, disconnect, subscribeQuotes, subscribeTrades, subscribeDepth(levels), getCandles(symbol, tf, from, to), snapshot, health, onStateChange, isActive?, contiguousSeq? }`. Adapters emit the internal schema (`Quote`, `Trade`, `DepthSnapshot`, `DepthDelta`, `Candle`, zod in `@kora/domain`). Every message carries `source`, `exchangeTs`, `receivedTs` (epoch ms) and `seq`; prices and sizes are decimal strings. The goal text's `exchange_ts`/`received_ts` are spelled camelCase on the wire, like the rest of the API. `DepthDelta.prevSeq` supports venues with ranged update ids (U/u).

- `SeqGapDetector` per (source, symbol, stream); `OrderBook` validates delta continuity. A gap triggers `snapshot()` resync, and the gap/resync is recorded in the feed status.
- Streams without contiguous per-symbol sequences (the broker pricing stream, crypto book tickers) declare `contiguousSeq=false`, so we never report false gaps.

### 4. Deterministic simulator

`SimulatedMarket` runs seeded GBM (xoshiro128**, one stream per symbol) with Markov regimes (range with mean reversion / trend / high-vol), asset-class spreads widened by regime and events, a 10-level depth ladder, Poisson trades at the touch, and **event shocks from the simulated economic calendar** (a jump plus a forced high-vol window for instruments exposed to the event's currency or country). It uses a virtual clock of 100 ms steps, so its output is a pure function of `(seed, startTs, specs, start prices, shocks)`. A committed snapshot (digest of 2 000 steps × 4 instruments) guards it. Float maths stays internal; `floatToPrice` is the single conversion point. Determinism holds for a given V8 (Node 22); a Node major upgrade may need a reviewed snapshot update.

`SimulatedAdapter` drives the market from a clock. On disconnect the market keeps its virtual time, and on reconnect the missed steps are skipped, never delivered, so consumers see a real gap. Other features:
- `freeze()` simulates a silent stall;
- `respectSessions` pauses closed venues (off by default, so the dev terminal is alive at weekends);
- history is generated backwards from the live start price, so history and live join without a jump;
- any registry instrument can be simulated, using the asset-class default profile when there is no explicit one;
- restarts continue from the last stored close.

### 5. Stubs for real providers, behind flags

The stubs are `broker-fxcfd` (generic pricing stream), `crypto-testnet` (generic diff-depth stream) and `equities-provider` (generic event-array stream, L1 only). Each has real decoders and subscription encoders on top of a stub transport:
- `RecordedTransport` replays hand-crafted fixtures labelled `HAND-CRAFTED FIXTURE` (a test also checks they contain no secret-like keys);
- `UnconfiguredLiveTransport` refuses to connect (OQ-B1/B2).

Each stub is off unless `KORA_MD_ADAPTER_FXCFD`, `KORA_MD_ADAPTER_CRYPTO_TESTNET` or `KORA_MD_ADAPTER_EQUITIES` is exactly `true`. One shared contract suite runs on every stub. The formats are modelled on common public patterns, not copied from any vendor.

### 6. Storage without TimescaleDB

The build environment has no TimescaleDB, so the tables are plain:
- `md_trades` and `md_bars_1s` become hypertables with retention policies only inside the `IF EXISTS timescaledb` guard;
- `md_candles` emulates continuous aggregates: `md_refresh_candles(p_from)` rolls up hierarchically (1s → 1m → 5m → 15m → 1h → 4h → 1D, UTC `date_bin`, idempotent). The feed calls it every 2 s for the touched window;
- `md_candles_history` holds the SIMULATED backfill. `/candles` merges both per bucket (open from history, close from live, max/min, sums);
- retention runs hourly through `md_apply_retention()`: trades 7 d, 1 s bars 7 d, 1m candles 90 d.

True Timescale continuous aggregates are deferred to a Timescale-equipped environment (B-201).

### 7. Distribution

The feed and the gateway meet only through Redis:
- `PUBLISH <prefix><channel>` plus a last-value `SET` per channel;
- `KORA_MD_FEED=inprocess` for dev and tests, or `off` with `md:feed` as a separate process.

The gateway is a `ws` server attached to the Nest HTTP server at `/ws`. We used `ws` rather than `@nestjs/websockets` for control over backpressure and zero per-frame overhead.
- **Auth:** the `kora_at` cookie with an Origin allow-list (CSWSH defence), or a first `{op:"auth"}` message. The global MFA rule applies, sockets close when the token expires, 5 s auth timeout, 60 ops/10 s rate limit, channel cap.
- **Subscriptions** are reference-counted per channel: one Redis `SUBSCRIBE` while at least one client listens. New subscribers get a snapshot of the last value.
- **Conflation** is a per-channel token bucket: 10 updates/s sustained with a burst of 2, so at most 12 in any single second and never more than 10/s on average. Above the rate, only the latest value is kept and sent when a token frees. We first built a strict "10 in any sliding second" window, and it was **rejected on measurement**: fed at exactly 10 Hz, it echoes every jitter or GC delay forward to the send ten messages later, and added about 16 ms of median delay under load. Depth is published as top-N snapshots, so conflation never breaks book state.
- **Fan-out** builds each frame once as raw RFC 6455 bytes and writes the same Buffer to every subscriber's socket. Writes are corked, so each client gets one `writev` per event-loop turn; `KORA_MD_WS_FLUSH_MS` adds an optional coalescing window (lower CPU for about 5 ms more latency). Profiling showed the per-frame write syscall was the cost. It skips a client above 1 MiB buffered and closes it above 8 MiB (1013). The gateway relies on `ws`'s underlying `_socket`, which is safe because per-message deflate is off, so `ws`'s own sends are synchronous writes to the same socket. It is covered by the integration tests and must be re-checked on `ws` upgrades.

### 8. Staleness and status

A quote is `stale:true` when:
- its adapter is not connected (immediately); or
- its age exceeds the asset-class threshold (checked every 250 ms, only while the symbol's session is expected to tick).

The feed publishes `status` every second and on every change:
- `ok`;
- `degraded`: any feed down or resyncing, or any stale symbol.

The gateway watches that heartbeat. If it stops for 2.5 s (the feed process died), the gateway publishes `down` (`feed_heartbeat_lost`) and re-sends the last quotes with `stale:true`. So `down` means "no feed process". An adapter outage while the process is alive is `degraded`.

### 9. SDK

`MarketDataSocket` (packages/sdk) provides:
- typed `quotes`, `depth`, `candles` and `status` helpers, with client-side ref-counting;
- auth op (static token or provider) or cookie;
- exponential backoff with jitter (`crypto.getRandomValues`, not `Math.random`), capped;
- resubscribe and re-auth after reconnect, and an application ping that recycles silent sockets;
- a stop on auth rejection unless a token provider can refresh.

REST methods are added to `KoraClient`.

## Consequences

- Goal 03 reads prices from the Redis last-value cache or subscribes in-process (see STATUS "What goal 03 needs"). It must honour `stale` and `status` before filling.
- Load test (Node generator; k6 blocked here): 500 clients × 20 of 200 symbols at 10 Hz gives p99 13.1 ms at 100 k frames/s, and a 200 k frames/s stress run gives p99 13.3 ms, on a 4-vCPU host shared with the generator (plan 02 §7.3). The gateway is single-threaded. Horizontal scale is by running more api instances, since Redis fans out to each and subscriptions are per instance (B-207).
- Deferred: Timescale caggs (B-201), GBX/minor-unit pricing (B-202), per-user connection quotas (B-203), licensed reference data and holiday calendars (B-204, OQ-M2), real provider transports (B-205, OQ-B1/B2).
