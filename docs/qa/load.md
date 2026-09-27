# Load tests — RC-1 (goal 10)

Owner: S10 (QA/SRE) with S3 (architect). Run: 2026-09-27. Harness: `apps/api/load/platform-load.mjs`
(scenarios A–C) and `apps/api/load/ws-fanout.mjs` (goal 02 fan-out). Raw results:
`apps/api/load/results/platform-2026-09-27T01-47-25-786Z.json` (final),
`platform-baseline-2026-09-27T00-51-39-651Z.json` (before the fixes below),
`ws-fanout-500c-200s-20k-flush0.json` (fan-out re-run).

**Environment (read the numbers with this in mind):** one shared cloud VM, 4 vCPU (Xeon 2.1 GHz),
17 GB RAM, Node 22. The load generator, one api process, quant (2 workers), the bot runner,
Postgres 16 and Redis 7 all run on the same host. No Docker. A production deployment runs several
api replicas on dedicated hosts (B-207), so these are conservative single-process numbers.

**Why not k6:** the k6 binary cannot be downloaded here (GitHub release assets are blocked). The
harness uses a constant-arrival-rate generator on `node:http` (the same model as k6's
`constant-arrival-rate` executor) and `ws` clients in worker threads. `ws-fanout.k6.js` stays
committed for CI/Docker. autocannon was tried first and dropped: its paced mode sends requests in
bursts, which measured its own queueing (it reported p99 363 ms for orders that the server acked in
under 40 ms at a steady rate).

## Scenarios

| # | Scenario | Load |
|---|---|---|
| A | 500 concurrent terminal users | 500 WebSocket clients subscribed to 5 quote streams + 500 REST reads/s rotating over quotes, candles (200 × 1m), account, positions, open orders, feed status; 100 real trader accounts (MFA, appropriateness passed) |
| — | 200 symbols streaming (goal 02) | 200 symbols × 10 msg/s on the bus → 500 clients × 20 symbols each (100,000 frames/s out) |
| B | Order burst 100 orders/s | 3,000 market orders at a constant 100/s over 100 accounts for 30 s, then 3 spikes of 100 simultaneous orders |
| C | 50 bots on 1m bars | 50 PAPER robots (BTC/ETH, SMA strategies) through 4 bar closes, then 10 owners hit the kill switch (robots + cancel + flatten) together |

## Results against the targets

| Target (source) | Result (final run) | Verdict |
|---|---|---|
| WS fan-out p99 < 50 ms, 200 symbols × 10 msg/s to 500 clients (goal 02) | **p99 10.3 ms**, delivered ratio 1.0, 0 drops, 0 client errors | PASS |
| `GET /candles` p95 < 150 ms (goal 02, "locally") | **p95 91.7 ms, p99 205.9 ms** while serving 500 REST reads/s + 500 sockets | PASS |
| Pre-trade risk < 5 ms (goal 03) | risk evaluation (`riskMs` on every `order.new`): **p50 0.029 ms, p99 0.089 ms, max 1.7 ms** over 3,300 orders. The `risk.evaluate` span including its database reads averaged 7 ms under the burst | PASS |
| Kill switch < 2 s (goal 03, SLO-3) | 10 simultaneous kill switches while 50 robots ran: **durationMs 83–179 ms**, all 202, every owner's robot halted | PASS |
| Order ack p99 < 250 ms (SLO-2) at 100 orders/s | **p50 16.7 ms, p95 23.9 ms, p99 35.6 ms, max 78 ms**; 3,000/3,000 accepted and filled; error rate 0 | PASS |
| No duplicate orders, audit chain intact | 0 duplicate `clientOrderId`s, 3,300 orders = 3,300 fills, `/health` audit chain ok | PASS |
| 50 bots on 1m bars (goal 06: one decision per robot per bar) | 200/200 decisions (50 per bar × 4 bars); bar close → decision **p50 1.49 s, p99 1.85 s** (internal target < 5 s, well inside the 60 s bar) | PASS |
| 500 terminal users, REST error rate | 15,000 requests at 500/s: 14,998 × 200, **2 client connection errors (0.013 %)**, no 4xx/5xx | PASS (no target beyond "errors recorded") |
| 500 terminal users, streaming | 500/500 sockets, 0 errors, 800,000 quotes; quote age (feed receive → client, includes the 5 ms flush and conflation) **p50 9 ms, p99 58 ms** | informational |
| 500 terminal users, REST latency (no goal 02/03 target) | overall **p50 4.7 ms, p95 82 ms, p99 406 ms**; account/positions p99 0.75–1.04 s (see exception E-1) | exception E-1 |
| Spike: 100 orders at the same instant (beyond the goal: a burst, not a rate) | worst spike p50 521 ms, **p99 725 ms**, all 300 accepted, 0 errors | exception E-2 |

## Findings fixed during the run

| # | Finding (evidence) | Fix | Effect |
|---|---|---|---|
| F-1 | Orders queued on the database pool (10 connections; `pg-pool.connect` waits 100–200 ms) | Pool size `KORA_DB_POOL_MAX` (default 20) | pool waits no longer dominate |
| F-2 | The account and positions snapshots valued the account twice per change | one valuation serves both | − one positions + quotes read per order |
| F-3 | `sessionStatus` ran ~150 `Intl` formatting calls per order (9 % of api CPU) | order path and research data use `sessionState`; `sessionStatus` memoised per minute (tested against a fresh computation across edges and DST) | CPU idle 35 % → 46 % under the burst |
| F-4 | The global audit-chain lock was the order path's bottleneck (lock wait mean 88 ms at 100/s) | migration 0102 `audit_chain_lock_head()`: READ COMMITTED check, lock and head read in one round trip (fresh snapshot per statement) | one round trip less inside the platform's only global lock |
| F-5 | Candle reads spent ~15 % of api CPU re-rounding 800 decimal strings already on the tick grid | `formatPrice` fast path (property-tested equal to the rounded answer) | open-loop REST at 500 reads/s: p50 242 ms → 4.7 ms, p99 1.99 s → 406 ms |
| F-6 | Bot runner evaluated 4 bar closes at a time (50 robots: p99 13.8 s) | `KORA_BOT_RUNNER_CONCURRENCY` (default 16) | p99 1.85 s |
| F-7 | Tracing wrote every span synchronously to its file exporter | batched exporter | tracing no longer adds latency in the drills |
| F-8 | A logged-out session could still open a WebSocket (S9, found while load testing) | WS auth checks server-side session state (close 4401) | test in `security-hardening.int.test.ts` |

Before → after (same harness, same host): orders at 100/s p99 363 ms (bursty generator) → 35.6 ms;
server-side order ack mean 227 ms → 16 ms; REST at 500/s p99 2.1 s → 406 ms; 50-bot decision p99
13.8 s → 1.85 s; WS quote age p99 335 ms → 58 ms.

## Exceptions (owned, pending Sponsor acceptance)

| # | Exception | Why | Mitigation / next step | Owner |
|---|---|---|---|---|
| E-1 | Account and positions reads reach p99 0.75–1.04 s when one api process serves 500 reads/s **and** 500 sockets on a shared 4-vCPU host | The single Node process is CPU-saturated in this setup (framework, JWT verification, JSON); p50 stays under 5 ms | Run ≥ 2 api replicas behind the ingress (B-207); re-measure on staging hardware before launch; no goal 02/03 target is breached | S3 |
| E-2 | 100 orders arriving at the same instant see p99 725 ms | Every order appends to the one hash chain, whose lock serialises commits (by design, ADR 0102) | Sustained 100/s meets SLO-2 with 7× margin; group-committing audit batches is the next lever if a spike SLO is set | S4 |

Neither exception affects correctness: no errors, no duplicates, the chain verifies.
