# Chaos and resilience drill (goal 10)

Owner: QA / SRE (S10). Script: [`scripts/chaos/run.mjs`](../../scripts/chaos/run.mjs) — reproducible with
`pnpm build && node scripts/chaos/run.mjs` on the native stack (no Docker). Raw evidence:
[`chaos/run.json`](chaos/run.json) (every check with timings and HTTP statuses), component logs in
[`chaos/logs/`](chaos/logs/), screenshots in [`chaos/screenshots/`](chaos/screenshots/).

## Set-up

An isolated stack, started and torn down by the script:

| Component | How it runs in the drill |
|---|---|
| Postgres | `kora_e2e` database, reset and migrated first |
| Redis | its own `redis-server` on port 56390 (no persistence), so killing it cannot touch the dev Redis |
| Market data adapter | the standalone feed process (`dist/market-data/feed-cli.js`, SIMULATED adapter), api with `KORA_MD_FEED=off` |
| api | production build `dist/main.js`, paper engine loop on |
| quant | uvicorn on port 8030 |
| bot runner | real runner (BullMQ) with a PAPER probe robot evaluating every closed 1-minute BTC/USD bar |
| AI provider | a local Anthropic-compatible fake endpoint (`ANTHROPIC_BASE_URL`), no key, no network; model id is a dummy env value |
| web | `next start`; every API call goes through the web `/api` proxy with a cookie session, like a browser |

Faults are hard kills (`SIGKILL`) of one component at a time; the AI provider fault closes its
listening socket. After each fault the component is restarted and recovery is checked.

## Expected behaviour vs result

| Expected (goal 10 §3) | Result |
|---|---|
| Graceful degradation | **Pass.** Feed down → `status: down`, quotes `stale: true`; Redis down → `/health` `degraded`, account and quotes still answer 200 (unpriced / no quote); quant down → 503 "Nothing was simulated" and the runner skips the bar; AI down → friendly "The AI service is not reachable right now" message, HTTP 200. |
| Stale badges | **Pass.** The watchlist shows **Stale** for BTC/USD and ETH/USD 2.6 s after the feed dies; status bar "Feed: simulated · down" ([screenshot](chaos/screenshots/01-feed-down-stale-badges.png)). |
| Kill switch still works via REST | **Pass** with the feed down (202 in 16 ms) and with **Redis down** (202, account halted) ([screenshot](chaos/screenshots/02-feed-down-kill-switch-rest-halted.png)). |
| No orders on stale data | **Pass.** Market orders during the feed outage → 422 `MARKET_DATA_STALE`; during the Redis outage → 422 `NO_MARKET_DATA`; zero fills for any order sent during an outage; no robot decision or order while quant was down. |
| Recovery without duplicated orders | **Pass.** After each restart a new order fills exactly once, the client retry of the same `clientOrderId` replays (200, `idempotentReplay`), the retry of a refused order stays refused; no duplicated client order id and no over-filled order in the whole database; audit chain valid; reconciliation clean. |

Overall: **41/41 checks passed** in 142 s (re-run of 2026-09-27 for IRTC R6-09; see `run.json` for the
exact timings; the per-step table below is from the first run). Since R6-09 the checks can fail: the
stale badge must be visible on its own (a stale API quote is a separate step), and reconciliation runs
over every account as a risk officer and passes only on HTTP 200 with an empty `mismatches` array
(2 accounts checked, 0 mismatches). The drill also confirms the risk warning when its trader passes
the assessment (IRTC R4-09 gate).

## Findings fixed by the drill

1. **Redis outage turned reads into HTTP 500** (first run): `/accounts/me`, `/positions`, `/quotes` and
   `POST /orders` threw `MaxRetriesPerRequestError` from the last-value cache. `ChannelHub.getLast`
   now answers "no value" while Redis is not ready (fail fast, no retry wait), so valuations show as
   unpriced and orders are refused with `NO_MARKET_DATA` (422) instead of 500. Re-run: pass.
2. **Drill design:** the kill switch pauses robots and resuming trading does not restart them (by
   design, goal 06); the drill now restarts the probe robot as its owner and first proves bar
   processing with quant up before simulating the quant outage.

## Observations for the backlog (not safety issues)

- ~~While the feed is down the order book and the ticket's buy/sell buttons keep showing the last
  depth/quote without a stale marker~~ **Fixed in goal 10:** the ticket shows "⚠ Stale price … orders
  that need a price are refused" and "Stale" on both buttons, the order book shows a stale banner
  (`data-stale`); the drill now checks both ("ticket and order book mark the price stale").
- The status bar shows "Robots: none" for a user whose robot is running on the monitor: B-1002.

## Results

### baseline

Fault: none.

| t (s) | Check | Result | Evidence |
|---|---|---|---|
| 6.4 | feed status ok | PASS | ms=20 |
| 6.5 | market order accepted | PASS | status=201, orderStatus="filled" |
| 6.5 | baseline order filled by the engine | PASS | fills=1 |
| 6.7 | probe robot running (PAPER) | PASS | status=200 |

### market-data adapter killed

Fault: SIGKILL of the standalone feed process (md:feed).

| t (s) | Check | Result | Evidence |
|---|---|---|---|
| 10.1 | api detects the lost feed heartbeat (status not ok / feedLost) | PASS | ms=2607, status="down", feedLost=true |
| 12.9 | stale badge on the watchlist (re-run adds: ticket and order book mark the price stale — PASS) | PASS | quoteStale=true, badgeVisible=true, screenshot="docs/qa/chaos/screenshots/01-feed-down-stale-badges.png" |
| 12.9 | no order on stale data: market order refused with a data code | PASS | status=422, code="MARKET_DATA_STALE" |
| 14.4 | no fill while the feed is down | PASS | fillsBefore=1, fillsAfter=1 |
| 14.5 | kill switch works via REST while the feed is down | PASS | status=202, durationMs=15 |
| 14.8 | resume after the halt | PASS | status=200 |
| 15.8 | feed recovers (status ok) after restart | PASS | ms=1040 |
| 15.9 | recovery without duplicates: retried order replays, refused order stays refused | PASS | first=201, retry=200, replay=true, refusedRetry=422, rows=[{"client_order_id": "chaos-recover-1790469486803-3", "n": 1}, {"client_order_id": "chaos-stale-1790469486803-2", "n": 1}] |
| 16.0 | exactly one new fill after recovery | PASS | fills=2, expected=2 |

### Redis killed

Fault: SIGKILL of redis-server (quotes cache, bus, BullMQ, WebSocket fan-out).

| t (s) | Check | Result | Evidence |
|---|---|---|---|
| 18.2 | health degrades with redis down (api stays up) | PASS | status="degraded", redis="down", ms=60 |
| 21.4 | reads degrade instead of failing: account and quotes answer 200 (unpriced / no quote) | PASS | account=200, quotes=200, quote=null |
| 21.4 | no order without market data (quotes cache unreachable): refused with NO_MARKET_DATA | PASS | status=422, code="NO_MARKET_DATA" |
| 21.5 | kill switch works via REST while Redis is down | PASS | status=202, halted=true |
| 21.5 | no fill while Redis is down | PASS | fills=2, before=2 |
| 22.5 | health back to ok after Redis restarts | PASS | ms=1015 |
| 22.5 | feed republishes into the fresh Redis | PASS | ms=12 |
| 22.5 | resume | PASS | status=200 |
| 22.6 | probe robot restarted by its owner after the halt | PASS | status=200 |
| 22.6 | recovery without duplicates after Redis restart | PASS | first=201, retry=200, fills=3, expected=3 |
| 22.7 | bot runner reconnects (health ok) | PASS | runner="ok", ms=3 |

### quant service killed

Fault: SIGKILL of the quant service (uvicorn).

| t (s) | Check | Result | Evidence |
|---|---|---|---|
| 23.7 | simulator answers 502/503 "Nothing was simulated" | PASS | status=503, message="The simulation service is not reachable right now. Nothing was simulated." |
| 26.0 | manual trading unaffected by the quant outage | PASS | status=201, fills=4 |
| 55.5 | runner evaluates closed 1-minute bars (quant up) | PASS | signals=1 |
| 123.2 | runner skips the bar (no decision, no robot order) while quant is down | PASS | signalsBefore=1, signalsDuring=1, robotOrders=0 |
| 124.5 | simulator recovers | PASS | status=200 |
| 132.6 | runner evaluates the next bar again after recovery | PASS | signals=2 |

### AI provider down

Fault: the (fake) AI provider endpoint stops accepting connections.

| t (s) | Check | Result | Evidence |
|---|---|---|---|
| 132.7 | baseline: copilot answers through the provider | PASS | status=200, answer="ok" |
| 134.1 | copilot degrades to a friendly message (no error page) | PASS | status=200, answer="error", message="The AI service is not reachable right now. Please try again shortly." |
| 136.4 | trading unaffected by the AI outage | PASS | status=201, fills=5 |
| 136.5 | copilot recovers when the provider is back | PASS | answer="ok" |

### integrity after the drill

Fault: none.

| t (s) | Check | Result | Evidence |
|---|---|---|---|
| 136.5 | no duplicated client order ids anywhere | PASS | duplicates=0 |
| 136.5 | no order filled beyond its quantity | PASS | overfilled=0 |
| 136.5 | no fill for any order sent during an outage | PASS | fills=0 |
| 136.5 | audit chain still valid | PASS | status=200, valid=true |
| 136.6 | reconciliation clean after the drill | PASS | status=200, mismatches=0 |
