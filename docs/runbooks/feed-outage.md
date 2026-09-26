# Runbook — market data feed outage

Category `feed_outage`. SLOs: SLO-4 (freshness), SLO-5. Controls: KC-15 (orders that need a safe
market are refused), KC-20. Owner: SRE on call; S4 for the feed code.

## Symptoms and signals

- WS `status` channel / `GET /market-data/status` shows `degraded` or `down`; the gateway marks the
  feed lost when no heartbeat arrives for `KORA_MD_FEED_TIMEOUT_MS` (2.5 s) and flags quotes stale.
- Terminal: "Stale" badges (not "Closed", which is a normal session state, B-208); Novice: "Prices paused".
- Orders that fill now are refused with `MARKET_DATA_STALE`, `FEED_NOT_OK` or `NO_MARKET_DATA`
  (visible as `risk.limit_breach`-free rejections in control KC-15 evidence); resting orders are held.
- Robots skip decisions on stale data; the supervisor may auto-pause them (`robot.*` alerts).

## Triage (first 5 minutes)

1. Is it one symbol, one source or everything? `GET /market-data/status` lists `staleSymbols` and
   each feed's `lastMessageTs`, gaps and resyncs.
2. Is it a venue session change (market closed, holiday, lunch break)? Check `GET /calendar` and the
   instrument's session: that is **not** an incident.
3. Is Redis up (`GET /health`)? The feed publishes through Redis; a Redis outage looks like a feed outage.
4. Log the incident (P2 by default; P3 if one non-major symbol).

## Contain

- The platform is safe by default: no fill on stale data (goal 03 fill safety). Do **not** override.
- If robots keep failing, pause them or use the kill switch scope 1 (robots only); scope 2/3 are not
  needed for a pure data outage.
- Tell customers in the product banner that prices are paused; no trading prompts.

## Diagnose and recover

1. In-process feed (`KORA_MD_FEED=inprocess`): check the api logs for `FeedService`; the gap detector
   triggers a snapshot resync automatically (goal 02). A restart of the api resumes the simulator.
2. Separate feed process (`pnpm --filter @kora/api md:feed`): restart it; confirm the `status`
   heartbeat returns (`feed heartbeat restored` in the gateway log).
3. Provider adapters are flagged stubs until licensed (OQ-B2, OQ-M3): a real provider outage follows
   the provider's status page; switch to the secondary source when contracts exist.
4. Admin controls (audited): `POST /market-data/feeds/{source}/stop|start` to force a clean restart.

## Verify

- `status` = `ok`, `staleSymbols` empty, fresh `seq` numbers; held orders resume filling on the next
  sweep; run `POST /reconciliation/run` (expect no mismatches).

## Close

Resolve with the cause (network, Redis, provider, bug). P1/P2 need a post-incident review. Evidence:
KC-15 (rejections by code during the window), KC-20.
