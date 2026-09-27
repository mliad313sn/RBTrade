# ADR 0006 — Robot trader: DSL, single evaluator, backtester, bot runner ↔ OMS, promotion

- Status: Accepted (2026-09-26)
- Deciders: S5 (quant developer, lead), S2 (senior trader / quant), S4 (trading-systems engineer), S8 (risk and compliance), S3, S9, S10, Project Owner
- Context: goal 06, STATUS goal 03 hand-over (`OmsService.submit` with actor `robot`, `kora:ctl:robots`, B-301), goal 05 (`/sim/from-trades`, B-502), the 2026-09-26 scope amendment (any asset class on any venue).
- Related: [plan 06](../plans/06-robot-trader.md), [backtester](../quant/backtester.md).

## Decisions

### 1. One versioned DSL, shared everywhere

`kora.strategy` v1 is a zod schema in `packages/domain/src/strategy` (web builder, api, bot runner)
with a pydantic mirror in `services/quant/src/kora_quant/bt/dsl.py`. A cross-language fixture
(`services/quant/tests/fixtures/strategy_templates.json`, rewritten by the domain test with
`UPDATE_FIXTURES=1`) holds the templates and the JSON Schema; the Python tests parse it, so the two
sides cannot drift silently. Numbers are literals or named parameter references, which makes sweeps,
heatmaps and "edit params" exact data changes. A new schema version will be `schemaVersion: 2` with
a migration function; stored versions are never rewritten.

### 2. Immutable, content-hashed versions

`strategy_versions` is append-only (trigger). `contentHash = sha256(canonical JSON)`; the UI shows
`#` + 6 hex. A new version needs a reason, carries the author, is audited with the parameter diff
and a `logicChanged` flag, and uses optimistic concurrency (`baseVersionId`, 409 when stale). Saving
identical content returns the existing version. Robots run a pinned version; switching is an
explicit, audited action on a paused robot.

### 3. The strategy is evaluated in one place (Python)

The backtester and the live bot share `decide()` in the quant service. The bot runner does not
re-implement indicators in TypeScript; at each bar close it asks quant (`POST /bt/signal`) with the
point-in-time window the api assembles. *Why:* parity by construction — the paper run and the backtest
can only differ in fills, which is exactly what the parity test measures. *Cost:* a live decision
needs quant up; if it is down the job retries with backoff and the robot takes no new action (fail
safe), and heartbeats still flow. Window = max(300, 3 × warm-up) bars (≤ 2,000), so SMA/EMA values
match the backtest when the window covers the history and converge otherwise.

### 4. Same costs as the paper engine (shared config)

The quant service has no fee tables. The api builds a `CostModel` per symbol from
`TradingRegistryService` (the paper engine's own source: `fee_schedules`, `asset_class_trading`,
instrument grid, multiplier) plus the SIMULATED market's configured spread, and sends it with each
request. Commission uses the same formula and rounding (golden vectors tested on both sides). Fill
policy, intrabar stop-first rule and funding are documented in `docs/quant/backtester.md`.

### 5. Look-ahead guard, trials and deflated Sharpe

A mandatory prefix-invariance guard recomputes features on `bars[:t+1]` at checkpoints and fails the
run on any difference. Trials are counted server-side per strategy (distinct configuration hashes),
not supplied by the client; the DSR uses them (Bailey & López de Prado 2014, reproducing the paper's
example). Optimisation has a hard cap (refuse, never truncate). *Amended 2026-09-27 (IRTC R3-01):*
it ranks on an inner validation segment and never reads the out-of-sample holdout, which is scored
once for the selected combination (see `docs/quant/backtester.md`).

### 6. Bot runner ↔ OMS: internal authenticated api endpoint (B-301)

Options considered:

| Option | For | Against |
|---|---|---|
| Share the Nest `TradingModule` inside the runner process | No HTTP hop | Two writers per account (breaks ADR 0003's single-writer lock model), DB credentials and the whole OMS in a second process, two copies of the matching loop |
| **Internal api endpoint** | One OMS process, the runner holds no DB credentials, ownership resolved server-side | One HTTP hop per decision (~ms at bar frequency) |

Decision: **internal endpoints** `/internal/robots/{running, :id/context, :id/decisions, tracking}`,
authenticated with a shared service token (`KORA_SERVICE_TOKEN`, ≥ 32 chars, constant-time compare;
the routes refuse to work when it is unset; user tokens are not accepted there and the token is not
accepted elsewhere). The api resolves robot → owner → account, requires the robot to be `running` in
PAPER on the claimed version and its owner to still hold a builder role (else the robot is paused),
then calls `OmsService.submit({userId: owner, roles: owner's current roles, actor: {type: 'robot',
id}, source: 'robot:{id}'})`. REST keeps refusing `robot:*`. Client order ids are derived from the bar
(`rb:<robot8>:<symbol>:<barTs>`) and `robot_signals` is unique per (robot, symbol, bar), so a replayed
job never submits twice. Entries carry the protective stop (and target) as bracket children; exits
are reduce-only market orders; trailing stops amend the stop child with the robot as the actor
(`OmsService.amend/cancel` gained an optional actor). A production deployment replaces the shared
secret with mTLS or a signed service JWT (B-608).

### 7. Supervision lives in the api, reaction lives in the runner

- Heartbeat: the runner refreshes `kora:robots:hb:{robotId}` every 5 s; the api's supervisor (1 s
  tick) pauses a running robot after 3 missed beats, raises a critical alert and audits it. The
  supervisor must be outside the runner, which cannot pause itself when it is dead.
- Kill switch: the runner subscribes to the goal 03 `kora:ctl:robots` channel; on `halt` it marks the
  account's robots halted in memory (no network round trip), drops their queued jobs, stops their
  heartbeats and publishes the reaction on `kora:robots:events` (measured < 1 s end to end in the
  integration test; the runner reacts in about 1 ms). The api pauses the robots (`kill_switch`) and
  audits; resume does not restart robots (explicit restart, refused while halted). The OMS also
  refuses robot orders while halted (`TRADING_HALTED`), so a decision in flight cannot trade.
- Per-robot limits: robot equity = allocation + realised − costs + unrealised from the robot's own
  fills (`orders.source`), marked at the exit side of the live quote. Daily/weekly loss and max
  drawdown breaches auto-pause with an alert (protective stops stay working); orders/minute and gross
  exposure refuse the order. Overnight funding is booked per account and not attributed to robots.

### 8. Tracking error

Daily job (runner cron → api): TE(D) = |live realised return − backtest realised return| for the same
version and bars since the paper start, both net of costs over the allocation; 30-day RMS for the
checklist. A realised basis keeps both sides comparable without re-marking history.

### 9. Promotion stays a record, never a switch

*Amended 2026-09-27 (IRTC R3-02, OQ-R8a):* the evidence is the latest **gate-eligible** backtest
(own parameters and universe, all history, default holdout, registry costs), which must also show a
holdout deflated Sharpe ≥ 0.95 with every recorded trial counted and ≥ 90 daily holdout observations;
trials are keyed by configuration and data context (symbols, window, split, cost override).
Checklist evidence: latest backtest OOS Sharpe ≥ `KORA_PROMOTE_MIN_OOS_SHARPE` and ≥ 100 OOS trades,
≥ 30 days paper with 30-day TE < 1 %, risk limits signed by a `risk_officer` who is neither the owner
nor the requester, bound to the current limits hash (a limits change invalidates it; a database
trigger enforces four-eyes too). Then a TOTP step-up (replay-protected, `DevIdpService.verifyStepUp`;
a Keycloak deployment uses the IdP's step-up, B-609). Every attempt with a valid code is recorded in
`robot_promotions` and audited; the result is always a refusal (`checklist_incomplete`,
`live_trading_disabled`, or `no_live_broker`). A trigger refuses `robots.mode = 'LIVE'`.

### 10. Novice access

The builder, research and robot APIs are trader/quant/admin only (the global guard returns 403; the
web shows the friendly page). `GET /strategy-templates` is open to every signed-in role, for goal 08.

## Consequences

- The quant service is on the live path of robots (not only research); it must be monitored and
  scaled with the runner (B-603).
- A robot shares its owner's paper account; the robot book is computed from its own fills, but a
  manual trade in the same symbol changes the account position the robot's reduce-only exits act on
  (documented; per-robot sub-accounts are B-605).
- Fat-finger bands apply to protective prices: a stop further than the asset class band (crypto 5 %)
  is refused by pre-trade risk, as for humans.
- History depth is whatever SIMULATED history exists (10 days by default in dev); licensed history is a
  Sponsor item (B-604, OQ-M2/OQ-B2).
