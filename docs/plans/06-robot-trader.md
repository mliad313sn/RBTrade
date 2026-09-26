# Plan 06 — Robot Trader: strategy DSL, backtester, overfitting controls, bot runner, promotion

Lead seats: S5 (quant developer), S2 (senior trader / quant), S4 (trading-systems engineer), S8 (risk).
Inputs: master goal (including the 2026-09-26 scope amendment), goal 06, STATUS (goal 03 "what goal 06
needs": `OmsService.submit` with actor `robot` and source `robot:<uuid>`, Redis `kora:ctl:robots`, B-301;
goal 05: `/sim/from-trades`, B-502), ADRs 0000–0102, BACKLOG, `design/prototype/Robots.png`.

Parallel work: goal 04 (Pro terminal) is built in the main tree at the same time. This goal owns
`services/quant` (backtester), `services/bot-runner`, `apps/api/src/robots` + `apps/api/src/strategies`,
`apps/web` robots route and components, and migrations `0060+`. Shared files get additive edits only.

## 1. Decisions up front

| Topic | Decision | Why |
|---|---|---|
| DSL | `packages/domain/src/strategy`: zod schema `kora.strategy` **v1** (`schemaVersion: 1`). Blocks: `entry` (side + AND-ed conditions), `filters` (AND-ed), `exit` (stop ATR/%, target ATR/R/%, trailing after xR, time stop, exit conditions), `size` (% equity risk, fixed qty, volatility target; max open positions). Condition types: `compare`, `cross`, `session_window`, `venue_open`, `no_event` (high-impact event within N min), `ai_regime` (goal 07, evaluates to `not_available` until then). Named `params` referenced as `{param: "fast"}` so sweeps and "edit params" are data. JSON Schema exported from the same zod schema for the web JSON tab and for Python. | One schema shared by web, api, quant and bot runner. Named params make optimisation, sensitivity and version diffs exact. |
| Versions | `strategy_versions` rows are immutable (trigger). `contentHash = sha256(canonicalJson(definition))`, shown as `#` + 6 hex. Every param/definition change creates `v(n+1)` with author and reason, audited `strategy.version_created` with the param diff. Saving an identical definition returns the existing version. | Goal 06 §1. |
| Evaluation lives once, in Python | The backtester and the live signal (`POST /bt/signal`) share one evaluator in `services/quant/src/kora_quant/bt`. The bot runner orchestrates (bars, limits, OMS, heartbeats) and asks quant for the decision at each bar close. | Parity by construction: the paper run and the backtest cannot disagree on logic, only on fills (which is what the parity test measures). |
| Cost model (shared config) | The api builds a `CostModel` for each symbol from the **same registry rows the paper engine uses** (`TradingRegistryService`: `fee_schedules` commission bps/per-unit/min and swaps, `asset_class_trading` impact ticks and vol factor, instrument tick/qty grid and multiplier) and sends it with every backtest/signal request. Spread: `simProfileFor(spec).spreadTicks` (the SIMULATED market's configured spread), overridable per request. Commission uses the identical formula (cross-language golden vectors). | "Same fee and slippage model as the paper engine (shared config)" without a second copy of the tables. |
| Fill convention | Decide on the close of bar t (data ≤ t only), fill at the **open of bar t+1** ± half spread ± vol term `ceil_tick(volFactor × |open(t+1) − close(t)|)`; commission per fill; swaps per 21:00 UTC roll held (ACT/360). Conservative intrabar policy: gap through stop → fill at open; stop and target both inside one bar → **stop first**; stop fills at stop − half spread − vol term; target fills at the limit exactly; exit conditions and time stops exit at the next open; open positions at the end are marked at the last close (`end_of_data`). Documented in `docs/quant/backtester.md`. | Goal 06 §3; mirrors the paper engine (stops trigger on the correct side, limits fill as maker at their price). |
| Look-ahead guard | Indicators are vectorised, but the engine runs a mandatory **prefix-invariance guard**: at checkpoints the feature matrix computed on `bars[:t+1]` must equal row t of the full computation; any mismatch raises `LookAheadError` and the run fails. The acceptance test injects a future-peeking indicator and asserts the backtest fails; a second test perturbs future bars and asserts past decisions do not change. | Goal 06 acceptance 1. |
| Splits | One run over the whole range, segmented by date: IS = before `oosStart` (default: last 30 % of bars is OOS). Walk-forward: anchored or rolling, k folds; with a param grid each fold picks the best IS params and trades the next test window; WF = the concatenated test windows. | Goal 06 §3. |
| Metrics | Daily (UTC) equity returns; annualisation factor = observed trading days per year (365 for 24/7 data, ~252 for weekday data). CAGR, Sharpe, Sortino, Calmar, max DD + duration, win rate, profit factor, expectancy (R and currency), trade count, exposure %, turnover, cost drag. Floats (statistics, ADR 0005 §4); fills and P&L are computed with float64 in the backtester and labelled SIMULATED, never booked. | Goal 06 §4. |
| Overfitting | Every evaluated param combination is a **trial** (`strategy_trials`, unique per strategy + param hash, with its IS/OOS per-period Sharpe). DSR (Bailey & López de Prado 2014) with N = distinct trials and V[SR] from the recorded trials; PSR when N = 1. Sensitivity heatmap over two params (≤ 12 × 12). Warnings: OOS trades < 100, OOS Sharpe < 50 % of IS. | Goal 06 §5. |
| Optimisation | Grid or seeded random search, hard cap `KORA_BT_MAX_COMBOS` (default 200, absolute ceiling 1,000), ranked by **OOS** Sharpe (IS shown next to it). | Goal 06 §6. |
| Bot runner ↔ OMS | **Internal authenticated api endpoint**, not a shared module: the runner (separate process) calls `/internal/robots/*` with a service token (`KORA_SERVICE_TOKEN`, ≥ 32 chars, constant-time compare; routes refuse when unset). The api loads the robot, checks ownership (robot → owner → account), that the robot is `running` in PAPER on that version, that the owner still holds a builder role, then submits through `OmsService.submit({userId: owner, roles: owner's current roles, actor: {type:'robot', id}, source: 'robot:<id>'})`. REST `source=robot:*` stays refused. | B-301. One order path; the runner holds no DB credentials and cannot act for another user's robot. |
| Runner design | BullMQ queue `kora-bots`: a candle subscriber (goal 02 `candles:{symbol}:{tf}`, `closed: true`) enqueues `bar_close` jobs (job id = robot + symbol + bar, so duplicates collapse); the worker fetches context, asks quant, posts the decision. Heartbeat every 5 s per robot (Redis key); the api's `RobotSupervisor` pauses a running robot after 3 missed beats (15 s), raises an alert and audits it. Kill switch: the runner subscribes to `kora:ctl:robots`, drops that account's robots and queued jobs immediately and reports on `kora:robots:events`; the api sets the robots to `paused` (`kill_switch`) and audits. Resume does not restart robots (explicit restart). | Goal 06 §7. |
| Per-bot limits | Robot equity = allocation + realised P&L − costs + unrealised (from the robot's own fills, marked at the current mid). Checked by the supervisor every second and at each decision: daily loss, weekly loss, max DD (auto-pause + alert), orders/min and gross exposure (the order is refused and audited). Positions keep their protective stop after an auto-pause. | Goal 06 §7. |
| Tracking error | Daily job (runner repeatable job + api endpoint): live daily robot return vs the backtest of the same version replayed over the same bars; TE(day) = |live − backtest|, 30-day TE = RMS. Stored in `robot_tracking`. | Goal 06 §7 + checklist. |
| Signal features | Every decision stores the evaluated operand values, each condition's result (`true/false/not_available`) and margin contributions (normalised distance of each condition from its threshold) in `robot_signals`; backtest trades carry the same for their entry signal. `GET /signals/:id/features` is the goal 07 `get_signal_features` source. | Goal 07 explainability. |
| Promotion | Checklist evidence: latest backtest OOS Sharpe ≥ `KORA_PROMOTE_MIN_OOS_SHARPE` (placeholder 0.8, OQ), ≥ 100 OOS trades, ≥ 30 days paper with 30-day TE < 1 %, risk limits signed by a `risk_officer` who is **not** the owner or requester (four-eyes, bound to the limits hash). Then a TOTP code (step-up, replay-protected). With `LIVE_TRADING_ENABLED=false` the request is refused (`live_trading_disabled`) but recorded in `robot_promotions` and audited. | Goal 06 §9. |
| Novice | `/robots/*` API and web are builder roles only (403 + friendly page). Templates are exposed read-only at `GET /strategy-templates` for any signed-in user (goal 08). | Goal 06 §2. |
| Monte Carlo | "Send to Monte Carlo" posts the OOS trades' R multiples to `POST /sim/from-trades` (`source: backtest_out_of_sample`); the simulator's "Import from backtest" lists the user's backtests and imports one. | B-502. |
| History for backtests | `md_candles_history` + live rollup through `CandlesService` (SIMULATED). Session flags per bar from the registry (`sessionStatus`), high-impact events from the SIMULATED calendar. | Any asset class / venue. Licensed history is a Sponsor item. |

## 2. Files

- `packages/domain/src/strategy/`: `dsl.ts` (zod v1, param resolution, semantic validation), `hash.ts`, `templates.ts` (Trend-X, MeanRev-Gold, Breakout-Crypto), `catalog.ts` (builder block catalog), `robots.ts` (robot limits, statuses, checklist types), tests; `strategy.schema.json` export test.
- `services/quant/src/kora_quant/bt/`: `dsl.py` (pydantic mirror), `indicators.py`, `evaluate.py` (conditions, features, contributions, look-ahead guard), `costs.py`, `engine.py` (portfolio bar loop), `metrics.py`, `dsr.py`, `research.py` (splits, walk-forward, optimisation, sensitivity), `models.py` (wire), `routes.py` (`/bt/run`, `/bt/walk-forward`, `/bt/optimise`, `/bt/sensitivity`, `/bt/signal`); tests incl. hand-computed toy trades, look-ahead guard, DSR reference values, cost golden vectors.
- `apps/api/migrations/0060_robots.sql`.
- `apps/api/src/strategies/`: strategies + versions, validation, templates controller, backtests (data service, cost model, quant calls, trials).
- `apps/api/src/robots/`: robots CRUD/start/pause/version switch, internal controller (service token), robot ledger (equity/limits), supervisor (heartbeats, limits, kill-switch listener), tracking, promotion (four-eyes, TOTP step-up), signals.
- `services/bot-runner/src/`: config, api/quant clients, candle subscriber, worker, heartbeats, control listener, tracking job.
- `apps/web`: `/robots` (monitor), `/robots/builder` (blocks, validation, JSON, import/export), components under `src/components/robots/`, `src/lib/robots/`; simulator "Import from backtest" enabled.
- Tests: domain unit, quant pytest, api integration (`strategies`, `backtests`, `robots-runner` (parity, crash auto-pause, kill switch ≤ 1 s, heartbeat), `promotion` RBAC), runner unit, web unit, e2e `robots.spec.ts`.
- Docs: this plan with results, ADR 0006, `docs/quant/backtester.md`, STATUS goal 06 section + G6 row, BACKLOG B-601+, open questions, README section, `.env.example`.

## 3. Schema (0060)

`strategies` (owner, name), `strategy_versions` (immutable: version, content hash, definition, author, reason, parent),
`backtest_runs` (kind `backtest|walk_forward|optimise|sensitivity`, request, result, trials, OOS summary),
`strategy_trials` (unique strategy + params hash, IS/OOS Sharpe, observations),
`robots` (owner, account, strategy, version, status `draft|running|paused|stopped`, mode `PAPER|LIVE` with LIVE refused by trigger,
allocation, limits, peak equity, pause reason, paper start), `robot_signals` (append-only features/contributions),
`robot_tracking` (robot, day, live/backtest return, TE), `robot_risk_signoffs` (signer ≠ owner enforced in SQL too),
`robot_promotions` (append-only request records with checklist evidence and outcome). GRANTs to `kora_app` / `kora_audit_reader`.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Logic drift between backtest and live | One evaluator (Python) for both; parity integration test through the real OMS. |
| Look-ahead bias | Mandatory prefix-invariance guard + injected-leak test + future-perturbation test. |
| Overfitting sold as edge | Trials counted server-side (not client-reported), DSR, OOS ranking, warnings on the KPI table, heatmap. |
| Runner acting for someone else | Service token + server-side robot → owner → account resolution; the runner never sends a user id. |
| Kill switch race with an in-flight decision | OMS refuses robot orders while halted (`TRADING_HALTED`); runner drops the account's robots on the control message; the api refuses decisions for non-running robots. |
| Parallel goal 04 merge | Only additive edits to shared files; migrations numbered 0060+. |
| Weekend sessions | Tests use BTCUSD (24/7) and controlled bars. |

## 5. Test plan

- Domain: schema accepts templates, rejects bad blocks with plain messages; hash stable across key order; param diff.
- Quant: indicators vs hand values; toy strategy on a fixed synthetic series equals hand-computed trades exactly; look-ahead guard fails on an injected leak; DSR equals the paper's example; E[max SR] vs Monte Carlo; metrics on hand series; walk-forward windows; optimisation cap and OOS ranking; sensitivity grid; cost golden vectors shared with TS.
- API integration: version immutability/new hash on param change + audit; novice 403 and templates for everyone; backtest via real quant; trial counting; runner parity (paper fills vs backtest trades within the slippage-model tolerance); simulated crash → auto-pause; kill switch → runner halted ≤ 1 s; heartbeat loss → pause + alert; promotion RBAC (every item, four-eyes, TOTP, LIVE flag).
- E2E: build Trend-X from blocks → backtest → heatmap → walk-forward → send to MC → paper-run → pause → edit params (new hash) → audit trail; novice sees the friendly 403.

## 6. Results (2026-09-26)

### 6.1 Gate (worktree branch, all green)

| Step | Result |
|---|---|
| `pnpm build` | 7/7 tasks |
| `pnpm lint` / `pnpm typecheck` | 12/12 tasks each |
| `pnpm test` | domain 123, api unit 40, bot-runner 11, web 18, sdk 11, market-data 60, ui 113, quant 124 (97.7 % coverage) |
| `pnpm test:integration` | 20 files, **137 passed** (19 new: strategies 7, robots 7, promotion 5) |
| `pnpm test:e2e` | **29 passed** (3 new in `robots.spec.ts`) |
| `pnpm py:check` | ruff, ruff format, mypy --strict clean; 124 passed |

### 6.2 Acceptance criteria

| Criterion | Evidence | Result |
|---|---|---|
| Look-ahead guard fails when future data is injected; toy strategy matches hand-computed trades exactly | `services/quant/tests/test_bt_guard.py` (leaky `highest` → `LookAheadError`, HTTP 422 `look_ahead`; perturbed future bars leave past trades identical); `test_bt_toy.py` (4 trades, every price, reason, stop, target, commission, net P&L, R multiple, bar index and final equity 99,987.91 computed by hand in the docstring) | **Pass** |
| Paper-run fills match the backtest trade list within the slippage-model tolerance | `apps/api/test/robots.int.test.ts` "parity": real bot runner process + real quant + real OMS over 70 SIMULATED 1-minute BTC bars; every fill's side and quantity equal the backtest legs and every price is within `ceil_tick(volFactor × |Δmid|) + 1 tick` | **Pass** |
| Deflated Sharpe matches the paper's reference values | `test_bt_dsr.py`: Bailey & López de Prado (2014) example → SR₀ 0.1132, DSR 0.9004 (±5e-5); E[max SR] vs Monte Carlo; PSR properties | **Pass** |
| Bot auto-pauses on a max-DD breach in a simulated crash; halts within 1 s of the global kill switch | `robots.int.test.ts`: −30 % crash → `paused / max_drawdown` in < 2 s with a critical alert and a `robot.auto_paused` audit event; `POST /kill-switch` → runner `halted` event received in < 1 s (runner reaction ≈ 1 ms), robot `paused / kill_switch` in < 1 s, later bars ignored, restart refused until resume. Also heartbeat loss (runner killed) → `heartbeat_lost` + alert | **Pass** |
| Promotion impossible without every checklist item and a different user's risk sign-off (RBAC) | `apps/api/test/promotion.int.test.ts`: novice 403; trader cannot sign; owner-risk-officer refused (API 403 `four_eyes` and DB trigger); stale limits hash 409; each item added one by one keeps it blocked; complete checklist + TOTP → 409 `live_trading_disabled`, recorded and audited; limits change invalidates the sign-off; `mode = 'LIVE'` refused by trigger | **Pass** |
| e2e: Trend-X from blocks → backtest → heatmap → walk-forward → MC → paper-run → pause → edit params (new hash) → audit trail | `apps/web/e2e/robots.spec.ts` (drag-and-drop of 7 blocks, inline params, JSON view, save v1, backtest, heatmap, walk-forward, Send to Monte Carlo, paper-run with runner heartbeat, pause, edit stop 1.5 → 1.4 as v2 with a reason, switch robot to v2 with a new hash, audit feed shows the parameter diff, start, pause, version change); axe on builder and monitor | **Pass** |
| STATUS update | `docs/STATUS.md` goal 06 section + G6 row | **Done** |

Also verified: tracking error per day (live vs backtest on the same bars, < 0.1 % of the allocation), B-301 (internal API refuses without the service token, REST still refuses `robot:*`), B-502 (simulator imports the latest backtest), novice 403 on builder APIs with templates open to all.

### 6.3 Deferred (with reasons)

- AI regime model (goal 07), copilot on `/robots` (goal 07): B-601, B-602.
- Licensed / long research history (Sponsor contracts): B-604.
- Live KPI ratios and mark-to-market tracking error need robot equity snapshots: B-606.
- Production service auth (mTLS / service JWT), HA of supervisor and runner, async long research jobs: B-608, B-610, B-613 (goal 10).
- Real LIVE promotion (broker, compliance, Keycloak step-up): Sponsor only, B-609.

### 6.4 Notes found while building

- A test caught the supervisor defaulting to "off" when `KORA_ROBOT_SUPERVISOR_MS` was unset; fixed.
- Unhandled async errors in the supervisor's Redis listener could crash the api when another environment published on the shared `kora:ctl:robots` channel before migrations; handlers now catch and log.
- Pre-trade fat-finger bands apply to protective prices: a stop further than the asset-class band (crypto 5 %) is refused, as for manual orders.
