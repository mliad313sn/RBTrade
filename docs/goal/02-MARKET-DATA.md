# /goal 02 — Market data service

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, `Main.dc.html` (watchlist, chart, order book, calendar).

## Goal
Deliver a normalised, real-time market data layer that every module consumes. It must include a deterministic **simulated feed**, so the whole platform works offline and in tests.

## Scope
1. **Instrument registry:**
   - `instruments` table: symbol, asset class (FX, metal, crypto, index CFD, equity, energy), base/quote, tick size, price precision, pip size, lot/contract size, min qty, qty step, trading sessions, margin rate by tier, fee schedule id, status.
   - Seed about 30 instruments matching the prototype watchlist.
2. **Adapter interface** `MarketDataAdapter`: `connect`, `subscribeQuotes`, `subscribeTrades`, `subscribeDepth(levels)`, `getCandles(symbol, tf, from, to)`, `health()`.
   - Implement `SimulatedAdapter`: seeded geometric Brownian motion with regime switching (trend/range/high-vol), realistic spreads by asset class, a depth ladder and volume, plus scheduled "event" shocks.
   - Write documented stubs, not live keys, for one FX/CFD broker, one crypto exchange testnet and one equities provider. Each sits behind a feature flag, with a contract test that uses recorded fixtures.
3. **Normalisation:** one internal schema for Quote, Trade, DepthSnapshot/Delta and Candle.
   - Every message carries `source`, `exchange_ts`, `received_ts` and `seq`.
   - A gap detector triggers a resync on missing seq.
4. **Storage:** TimescaleDB hypertables for trades and 1-second bars, with continuous aggregates for 1m/5m/15m/1h/4h/1D and retention policies.
5. **Distribution:**
   - Redis pub/sub feeds the NestJS WebSocket gateway, with channels `quotes:{symbol}`, `depth:{symbol}`, `candles:{symbol}:{tf}` and `status`.
   - Client subscriptions are reference-counted, with server-side conflation at most 10 updates/s per channel for the UI.
6. **Staleness:** a quote is flagged `stale:true` if its age exceeds the per-asset-class threshold (default FX 2 s, crypto 2 s, equities 5 s). The UI must be able to show a stale badge. The feed status is published on `status`.
7. **Economic calendar:** a simulated provider with an interface for a real one. Events carry time (UTC), country, impact 1–3 and title.
8. **SDK:** typed WS client in `packages/sdk` with auto-reconnect, resubscribe and backoff.

## Acceptance criteria
- [ ] The simulated feed with the same seed produces an identical sequence (snapshot test).
- [ ] `GET /candles?symbol=EURUSD&tf=15m&limit=500` returns in < 150 ms p95 locally with correct OHLCV aggregation (unit test against hand-computed bars).
- [ ] The WS gateway sustains 200 symbols × 10 msg/s to 500 simulated clients with p99 fan-out latency < 50 ms (k6 or artillery script committed with results).
- [ ] Killing the adapter makes `status` go `degraded` within 3 s and quotes turn `stale:true`. Restarting it recovers with a gap resync (integration test).
- [ ] Precision and tick rounding come from the registry, never hard-coded (property-based test with fast-check).
- [ ] `docs/adr/0002-market-data.md` and the STATUS update are written.
