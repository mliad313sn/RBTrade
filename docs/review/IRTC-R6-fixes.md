# IRTC R6 corrections: test integrity and reliability

Corrector for the R6 review (seat R6, report dated 2026-09-27 on `claude/magical-newton-yyxga6` @ `b2bb0b6`),
applied on top of the merged R1–R5 corrections (`ad438e9`). Process per CHARTER §6: confirm or refute each
finding, write a regression test that fails before the fix (or kills the mutant that showed the gap), fix
the root cause, and show the test passing. No product or policy decision was needed.

Evidence paths below are relative to the session scratchpad
`/tmp/claude-0/-home-user-RBTrade/528a68cd-e59a-54bf-af1d-f02a3ff25170/scratchpad/`:

- `irtc/R6-tests.md`, `irtc/r6/` hold the reviewer's report, mutation scripts and repro tests;
- `r6fix/mutate41.py` is the adapted mutation harness, and `r6fix/mut/` holds the scratch copy it mutated
  (`RBTrade/`), one log per mutant (`logs/`), `mutants.jsonl` and the unmutated baseline (`baseline.out`);
- `r6fix/g-*.log` and `r6fix/int-*.log` are the gate logs.

The repository itself was never mutated.

## Summary

| ID | Sev. | Verdict | Fix commit | Regression test |
|---|---|---|---|---|
| R6-01 | High | Confirmed | `00b64f0` | `packages/domain/src/audit.test.ts` "audit hash spec"; `audit.int.test.ts` "tampering <column> breaks the chain" ×8 |
| R6-02 | High | Confirmed | `2763b33`, `4911631` | `ai-no-side-effects.int.test.ts`; `ai.static.test.ts` (constructor allow-list, no SQL/casts) |
| R6-03 | High | Confirmed; current behaviour already holds (R2-14), invariant now explicit and tested | `e798d2c` | `irtc-r6.int.test.ts` "R6-03" |
| R6-04 | Medium | Confirmed | `e798d2c` | `irtc-r6.int.test.ts` "R6-04" |
| R6-05 | Medium | Confirmed | `e798d2c` | `irtc-r6.int.test.ts` "R6-05" (weekly and monthly) |
| R6-06 | Medium | Confirmed | `c963e18` | integration coverage floors; `anthropic.provider.test.ts` |
| R6-07 | Medium | Confirmed | `4630e60` | CI step renamed, `ai-evals-live` job, plan 07 criterion 5 corrected |
| R6-08 | Low | Confirmed | `e798d2c` | `irtc-r6.int.test.ts` "R6-08" |
| R6-09 | Low | Confirmed | `deba43a` | chaos drill steps (see below) |
| R6-10 | Low | Confirmed | `f3971d8` | Playwright `retries: 0` everywhere; flakes fixed (section "Flakes") |
| R6-11 | Low | Confirmed; the branch is intended defence in depth | `e798d2c` | `irtc-r6.int.test.ts` "R6-11" |
| R6-12 | Low | Confirmed | `fea3032` | unit tests "IRTC R6-12" (trading, AI, governance, main config) |
| R6-13 | Low | Confirmed | this report's commit | `docs/qa/coverage.md` re-measured |
| R6-14 | Low | Confirmed | `4630e60`, `d8e9903` | `pnpm format:check` in CI; ZAP artifact upload |
| R6-15 | Low | Confirmed (coupling and midnight straddle) | `7892705` | `irtc-r6.int.test.ts` "R6-15"; `awayFromUtcMidnight` |
| R6-16 | Low | Confirmed | `93a5d47`, `a7ffebd` | `terminal-visual.spec.ts` (fixture bodies vs OpenAPI + self-check) |

Mutation testing, before and after: **32/41 killed before, 41/41 killed after** (plus three extra mutants,
all killed). One mutant (LA-2) survived the first re-run on the current code and was killed by a new test
(`97cc2e9`). Details in "Mutation results".

## High

### R6-01 · Audit hash: no known-answer vector, no field-coverage test

- **Verdict: confirmed.** Every test built its chain with the function it verified with, and the
  database tamper test changed `payload` only. Mutants AUD-1 (drop `actor_id`) and AUD-2 (drop `ts`)
  survived.
- **Fix (tests only, the code was correct):**
  - `packages/domain/src/audit.test.ts` pins the ADR 0102 vector. The canonical body is written out by
    hand, and the expected hash `8cd10597…618a` was computed outside the code base (Python `hashlib`).
    Both `sha256Hex(body + genesis)` and `computeAuditHash(event, genesis)` must equal it.
  - The same file changes each hashed field in turn (`id`, `ts`, `actor_id`, `actor_type`, `action`,
    `entity`, `entity_id`, including `entity_id` → null, `payload`) and `prev_hash`. Each change must
    change the hash and make `verifyAuditChain` fail at that event, with the right reason.
  - `apps/api/test/audit.int.test.ts` tampers each column in Postgres (as the owner, trigger disabled):
    `actor_id`, `actor_type`, `ts`, `action`, `entity`, `entity_id`, `payload`, `prev_hash`.
    `/audit/verify` must break at that row (`hash_mismatch`, or `prev_hash_mismatch` for the link),
    and restoring the value must make the chain valid again.
  - ADR 0102 documents the vector, so an auditor can re-implement the check.
- **Mutants:** AUD-1 and AUD-2 are now killed by the domain KAT (and by the field tests).

### R6-02 · "AI never executes": four state kinds checked, denylist static scan

- **Verdict: confirmed.** AI-1 (a read tool calls `AccountsService.updateSettings`) and AI-3 (a read
  tool runs `UPDATE user_preferences` through a private DB handle) both survived.
- **Fix:**
  - **Code.** The tool backend no longer injects `AccountsService` or `ModuleRef`:
    - account reads go through `AiReadPorts.accountView/positions` (only `ensure`, `view` and
      `positionsView`);
    - the strip uses the same port;
    - the intel read service is bound into `IntelPortRegistry` by `IntelModule.onModuleInit`, where it
      used to be resolved with `moduleRef.get(…, { strict: false })`. The registry exposes only
      `radar`, `trendCard` and `news`.
  - **Static test (allow-list)** in `ai.static.test.ts`:
    - `AiToolBackend` may inject only `CandlesService`, `ChannelHub`, `AiReadPorts`,
      `CalibrationService`, `DraftsService`, `QuantClient`, `IntelPortRegistry` and `MdConfig`. Each
      entry has a reason;
    - `AiReadPorts` injects exactly the five services whose calls are checked. The allowed calls now
      include `accounts.ensure/view/positionsView`;
    - no `ai/` or `intel/` file may use `ModuleRef` or `@nestjs/core`;
    - tool code (`tool-backend`, `read-ports`, `intel-port`) contains no `DbService`, `Pool` or Redis,
      no `.query(` or `.tx(`, no SQL write verbs, no `as unknown as` or `as any`, and no
      `this.x[...]`;
    - `AccountsService` and `.updateSettings(` are forbidden everywhere else in `ai/` and `intel/`;
    - a self-check proves the constructor parser sees an injected writer.
  - **Integration test (whole database)** in `ai-no-side-effects.int.test.ts`. The trader first gets
    state of every kind:
    - a paper account and changed risk limits;
    - a preferences row (so an UPDATE has a row to hit, as the review noted for AI-3);
    - watchlists, a price alert, a strategy and a robot, a resting order, and a pending draft.

    Then every row of every table is fingerprinted, keyed by primary key. Four hostile turns follow:
    pro, injected untrusted text, "cancel/flatten/halt", and a novice turn. The adversarial persona
    calls every catalogue tool, including `get_account_risk`, `get_positions` and `get_order_preview`,
    plus every forbidden name. Afterwards no row may be updated or deleted in any table. Inserts are
    allowed only in `audit_events`, `ai_order_drafts` and `ai_strategy_drafts`, and derived
    calibration caches are skipped (all listed with reasons). A self-check proves the fingerprint
    notices an update and an insert.
- **Mutants:** AI-1 and AI-3 are killed by the static test. With the static test left out (the extra
  mutants AI-1b and AI-3b), the fingerprint kills them too. The AI-3 mutant now sets the view mode to
  `novice`: R6's version set `pro`, which is a no-op for a Pro-view user.
- **Not done:** a `SET TRANSACTION READ ONLY` guard around tool dispatch. The draft tools must write,
  and the two tests above now fail on any other write.

### R6-03 · Kill-switch flatten in a closed session

- **Verdict: confirmed as a test gap.** After R2-14 the behaviour is correct: the flatten skips
  pre-trade risk, `PaperEngineService.work` holds the order, and `holdReason` names the session. No
  test covered it, so FS-2 (the engine's session check dropped) survived.
- **Fix:** `irtc-r6.int.test.ts` "R6-03":
  - the scenario opens AAPL on Friday at 15:50 New York and fires scope 3 at 16:10, with fresh quotes
    and a healthy feed, so only the session is unsafe;
  - it expects `positionsFlattened: 0` and a pending flatten with a `session` reason;
  - it also expects the position to be untouched, the flatten order `working` with `filledQty 0`, and
    no fill rows.

  The invariant is documented on `KillSwitchService.flatten`.
- **Mutant:** FS-2 is killed.

## Medium

### R6-04 · Orders-per-minute window length

- **Verdict: confirmed.** RISK-5 (1 minute → 1 second) survived.
- **Fix:** three orders are placed, then their `created_at` is aged on the database clock:
  - aged 59 s, the 4th order must be refused `ORDER_RATE_LIMIT`;
  - aged 61 s, it is accepted.

  This pins the window from both sides without sleeping. R6's proposal was a 2.5 s sleep.
- **Mutant:** RISK-5 is killed. A too-long window (for example 1 hour) would fail the 61 s half.

### R6-05 · Weekly (and monthly) loss limit through the API

- **Verdict: confirmed.** RISK-9 (`weekPnl` = `dayPnl`) survived.
- **Fix:**
  - **Weekly:** a loss of about 300 USD is booked on the Monday. On the Wednesday of the same ISO week
    the day P&L is 0 and the week P&L is below −250. With daily limit 100 and weekly limit 200, a new
    order gets `WEEKLY_LOSS_LIMIT` and not `DAILY_LOSS_LIMIT`.
  - **Monthly:** a loss in an earlier week of the same month gives `MONTHLY_LOSS_LIMIT` only.
- **Mutant:** RISK-9 is killed.

### R6-06 · Coverage gates and the production LLM adapter

- **Verdict: confirmed.**
- **Fix:**
  - **Integration coverage gate.** `pnpm --filter @kora/api test:integration` now always runs with v8
    coverage over `src/**` (CLIs, `main.ts` and seeds excluded). The floors sit two to three points
    under the level measured today:

    | Scope | Measured (lines / branches) | Floor |
    |---|---|---|
    | Global | 92.4 / 82.9 (functions 96.0) | 90 / 80 (functions 94) |
    | `src/trading` | 96.9 / 86.9 | 94 / 84 |
    | `src/audit` | 96.2 / 84.9 | 93 / 82 |
    | `src/governance` | 84.7 / 82.5 | 82 / 80 |
    | `src/ai` | 89.1 / 77.9 | 86 / 75 |

  - **`AnthropicProvider` unit tests.** `anthropic.provider.test.ts` drives the provider through the
    **real SDK** with an in-memory `fetch` transport (no network, no key) and a placeholder model id.
    It checks:
    - the request body (model, streaming, system cache breakpoint, cache breakpoint on the last tool
      only, `tool_choice: auto`, adaptive thinking);
    - structured output (`output_config.format` plus effort, no tools, thinking omitted);
    - streamed text deltas and tool-use JSON assembly;
    - the usage mapping, including absent cache counters;
    - typed SDK errors for 429, 401, 403, 400, 404 and 500, and a connection failure, each mapped by
      `friendlyProviderError`;
    - the SDK retry on 529;
    - that construction is refused without `KORA_AI_MODEL`.

    The provider is in the unit coverage gate: 6.45 % → 100 % lines, 97 % branches.
- **Not done:** switching the unit allowlists to `src/**`. The integration gate now measures
  everything, and stateful code is covered at that layer.

### R6-07 · Eval gate honesty

- **Verdict: confirmed.**
- **Fix:**
  - The CI step is named "AI evals, scripted-provider regression (pipeline, guards and graders; not
    model quality)", with a comment that says why.
  - A new job, `ai-evals-live`, runs `pnpm evals:live` when the `ANTHROPIC_API_KEY` secret and the
    `KORA_AI_MODEL` variable exist. Otherwise it reports "skipped: no key" and passes.
  - `RELEASE_CHECKLIST.md` requires a green live run.
  - Plan 07 §6: criterion 4 reads "Pass (scripted-provider regression); live run pending". Criterion 5
    reads "Budgets: Pass. Grafana: deferred (dashboard JSON validated; not run)".

## Low

### R6-08 · Fat-finger band on SL/TP

- **Verdict: confirmed.** A stop loss 20 % away and a take profit 20 % away are each refused
  `FAT_FINGER`, and prices inside the band are accepted. RISK-8 is killed.

### R6-09 · Chaos checks that could not fail

- **Verdict: confirmed.** In `scripts/chaos/run.mjs`:
  - "api quote flagged stale" and "stale badge on the watchlist" are now two steps, and the badge
    step passes only if the badge is visible;
  - the reconciliation step grants the drill's trader `risk_officer`, signs in again and reconciles
    every account. It passes only on HTTP 200 with a `mismatches` array that is empty and
    `accountsChecked ≥ 2`.

  The drill result is recorded in the "Gate" section.

### R6-10 · CI retries and perf margin

- **Verdict: confirmed.** `playwright.config.ts` has `retries: 0` in CI too. Every flake in the list
  was root-caused and fixed (section "Flakes"). The tick-to-paint budget (p95 < 100 ms) is unchanged.
  The three gate e2e runs are in "Gate".

### R6-11 · `staleSymbols` branch

- **Verdict: confirmed.** The branch is intended defence in depth: the feed can list a symbol stale
  before re-stamping its quote.
- **Test:** a fresh, unflagged quote with the symbol in `staleSymbols` refuses a market order
  (`MARKET_DATA_STALE`) and holds a resting order until the list is cleared. FS-7 is killed.

### R6-12 · Test aids fail open when `KORA_ENV` is unset

- **Verdict: confirmed.**
- **Fix:** `isExplicitDevOrTest(env)` (`apps/api/src/config/env-mode.ts`) is true only for
  `KORA_ENV` exactly `dev` or `test`, and never with `NODE_ENV=production`. It now gates:
  - the session override;
  - the scripted and replay AI providers, and the public pseudonym salt;
  - unsigned audit anchors;
  - unauthenticated `/metrics`;
  - Swagger;
  - insecure cookies.
- **Tests:** unit tests cover unset, blank and misspelt values.
- **Extra mutant:** OVR-2 (unset counts as dev again) is killed.

### R6-13 · Stale QA evidence

- **Verdict: confirmed.** `docs/qa/coverage.md` is re-measured (see "Gate"): 50 integration files, the
  bot-runner branch figure, and a new integration coverage row.

### R6-14 · ZAP echo and no Prettier check

- **Verdict: confirmed.**
  - `release.yml` uploads `zap/` with `actions/upload-artifact`. It used to `echo`. The job still runs
    only after a staging deploy, and `docs/security/scans.md` records DAST as not run until staging
    exists.
  - Prettier ran over the whole repo in one `style:` commit (`d8e9903`, 395 files). Generated outputs
    and recorded evidence are listed in `.prettierignore`, and CI runs `pnpm format:check`.
  - Three Semgrep suppressions had to move back onto the line their finding starts on after the
    reflow.

### R6-15 · Hard-coded dates and the midnight straddle

- **Verdict: confirmed.**
- **Fix:**
  - `marketDay(days, hh:mm:ss)` derives every scenario clock in the trading tests from
    `MARKET_OPEN_UTC` (risk, trading integrity, terminal, R2 and R6 regressions);
  - `SEED_EFFECTIVE_UTC` names the date of the seeded legal content;
  - a test checks that the anchor is a Wednesday after the seeds, and that the earliest derived day
    (the Monday) is too;
  - the real-clock cooling-off test calls `awayFromUtcMidnight(120 s)` before it starts, so it can no
    longer straddle midnight between the database clock and the app clock.

  Calendar facts (DST roll times, the calendar window of a registry test) keep their literal dates on
  purpose.

### R6-16 · Visual fixtures not validated

- **Verdict: confirmed.** Every REST body the terminal visual fixture serves is validated against the
  200 response schema of `packages/sdk/openapi.json` with ajv 2020, the same document the contract
  tests use. Both visual tests assert no violations and that the key endpoints were served, and a
  self-check proves a drifted body is rejected. Only the pixel test uses `page.route`.
- **Real drift found:** on its first gate run the check failed. The `/health` fixture had no
  `db`/`redis`/`keycloak` checks, which the published schema requires; the fixture is fixed
  (`a7ffebd`).
- **Limit:** four fixture endpoints (`/ai/strip`, `/calendar`, `/me/watchlists`, `/price-alerts`) have
  no 200 response schema in the OpenAPI document, so their bodies cannot be checked. They are listed
  exactly in `UNSCHEMED_FIXTURE_ENDPOINTS`: any other unschemed endpoint is a violation, and the list
  fails once the api documents one of them. The missing schemas are an open item for the api owner.

## Mutation results

R6's 41 mutants were re-run in a scratch copy with `r6fix/mutate41.py`. The harness applies each exact
string (occurrence count checked), rebuilds `@kora/domain` when needed, runs the targeted suites until
one fails, then restores the file.

Adaptations to the current code:

- RISK-3 and RISK-9 now replace both OMS call sites;
- RISK-7 targets the R4-09 disclosure check;
- AI-1 and AI-3 target `read-ports.ts`, where account reads now live;
- OVR-1 targets the new guard line;
- LA-1, LA-2, LA-6 and LA-7 follow the reworked quant code.

Quant runs with `PYTHONPATH=src`, so the copy's package wins over the editable install of the real repo.
The unmutated copy passes every command used (`mut/baseline.out`).

| ID | Mutation | Before (R6) | After | Killed by (after) |
|---|---|---|---|---|
| RISK-1 | domain: drop NOVICE_STOP_REQUIRED | killed | killed | domain unit |
| RISK-2 | OMS: `hasStopLoss: true` | killed | killed | risk / novice integration |
| RISK-3 | OMS: `novice: false` | killed | killed | risk / novice integration |
| RISK-4 | domain: daily-loss sign flip | killed | killed | domain unit |
| RISK-5 | OMS: rate window 1 min → 1 s | **survived** | killed | `irtc-r6` R6-04 |
| RISK-6 | isNovice ignores the Novice view | killed | killed | integration |
| RISK-7 | risk warning never required | killed | killed | risk-warning-gate / compliance |
| RISK-8 | fat-finger ignores SL/TP | **survived** | killed | `irtc-r6` R6-08 |
| RISK-9 | weekly P&L = day P&L | **survived** | killed | `irtc-r6` R6-05 |
| FS-1 | fill on a stale/unhealthy feed | killed | killed | risk integration |
| FS-2 | fill in a closed session | **survived** | killed | `irtc-r6` R6-03 |
| FS-3…FS-6 | stale flag, quote age, heartbeat age, per-source feed state ignored | killed | killed | risk integration |
| FS-7 | `staleSymbols` ignored | **survived** | killed | `irtc-r6` R6-11 |
| RO-1 | reduce-only not clipped | killed | killed | orders integration |
| AUD-1 | hash omits `actor_id` | **survived** | killed | domain KAT + field tests |
| AUD-2 | hash omits `ts` | **survived** | killed | domain KAT + field tests |
| AUD-3 | verifier comparison disabled | killed | killed | domain unit |
| AI-1 | read tool calls `updateSettings` | **survived** | killed | `ai.static.test.ts` |
| AI-2 | `allowedFor` always ok | killed | killed | api unit |
| AI-3 | read tool writes `user_preferences` | **survived** | killed | `ai.static.test.ts` |
| FE-1, FE-2 | four-eyes checks removed | killed | killed | four-eyes integration |
| IDEM-1, IDEM-2 | idempotency hash checks removed | killed | killed | orders integration |
| KS-1…KS-4 | kill-switch scope 2, resume RBAC, halt vs robots, firm-halt self-resume | killed | killed | integration / domain unit |
| MFA-1 | MFA not required | killed | killed | auth / authz integration |
| WS-1 | private WS channels open | killed | killed | ws integration |
| OVR-1 | session override accepted in production | killed | killed | api unit |
| LA-1 | backtest guard disabled | killed | killed | quant |
| LA-2 | guard tolerance 50 % | killed (old code) | killed after `97cc2e9` | `test_guard_tolerance_catches_a_faint_finite_leak` |
| LA-3…LA-7 | regime features, one checkpoint, SMA leak, scanner guard, engine peeks | killed | killed | quant |
| *AI-1b* | AI-1 against the fingerprint only | — | killed | `ai-no-side-effects` |
| *AI-3b* | AI-3 against the fingerprint only | — | killed | `ai-no-side-effects` |
| *OVR-2* | unset `KORA_ENV` counts as dev | — | killed | api unit (R6-12) |

The first re-run killed 43 of 44 mutants; LA-2 survived:

- on the current code every existing leak test also produced a NaN in the prefix, and that is
  caught whatever the tolerance;
- the new test injects a finite leak of one millionth of the next bar's return;
- re-run: killed.

**No survivors remain.**

## Flakes

| Flake | Root cause | Fix |
|---|---|---|
| `tracing.int` "an order is one trace" (fails in the full run, passes alone) | The test waited on the file exporter's 500 ms batch timer by polling, so under load it read before the export. Separately, Nest's default shutdown hooks listen to SIGUSR2 (nodemon's restart signal), so no signal was free for an on-demand flush | With `KORA_OTEL_FILE` set, the api force-flushes its file span processor on SIGUSR2 and appends a marker line to `<file>.flush`. The test sends the signal, waits for the marker and reads, repeating a bounded number of times. Shutdown hooks are limited to SIGTERM, SIGINT, SIGHUP and SIGQUIT (`4511c72`). The test also pauses its robot so later files find no running robot (`4911631`, `c963e18`) |
| bot-runner "halts within milliseconds" (`haltedAccounts` 11) | The kill-switch channel `kora:ctl:robots`, runner events and heartbeats were global Redis keys. Any api or runner on the same Redis reached the test runner: a global kill switch halts every account. The health port 4198/4199 was fixed too | `KORA_ROBOT_CTL_PREFIX` (default `kora:`) namespaces the control plane in the api and the runner. Integration workers set `kora:test:<pid>:`, the runner unit test uses its own prefix and free ports, and each e2e run uses `kora:e2e:<api port>:` (`f3971d8`) |
| terminal.spec "settings density persist" | A lost update on the **server**: `PUT /me/preferences` read the row outside the transaction and wrote the merge back. Two saves in flight (time display, then density) both started from the old row, and the second write dropped the first. The client could also apply an older answer after a newer one | The row is created if missing and locked `FOR UPDATE` in the transaction. The settings form ignores stale answers. A regression test fires seven concurrent partial saves and checks that all land; it failed before the fix (`50a1fa0`) |
| terminal a11y/perf timeouts under load | Machine load (load average 13–14 on 4 cores) in the R2/R4 gates, with other sessions running | Not hidden: retries 0 and the budget kept. The gate runs had the machine to themselves (see "Gate") |
| R5-02 blotter Mark and Unrealized P&L (first read) | The row can render from the positions snapshot before the first live quote, and before the account snapshot that includes the new position. In that window the summary deliberately keeps the engine's figures ("trade in flight"), so the first same-frame read could disagree | Rows expose `data-live`. The test waits for a live row and one consistent frame, then samples 16 times and asserts agreement every time (`4c921b6`) |
| strategies.int B-502 OOS trade count | Other files seed BTCUSD 1h candles; fixed by R4 (the file clears the series before seeding) | Verified: green in every run here. No further change |
| sim B-501 slippage (order dependence) | Every `MarketFixture` started at `seq` 1, and the api caches the last quote per symbol by `seq`. A fresh fixture's quote could therefore reuse the mid move of another quote with the same number, and an earlier file could leave BTCUSD at another mid | Sequence numbers are unique per process (`Date.now() × 1000` counter). B-501 lets the api observe its book with a preview before the fill, so the move is 0 whatever ran before (`8feac51`) |
| preview.int `riskMs < 5` under load | A latency assertion on one cold sample | The 5 ms budget stays enforced on the p95 of 200 previews; the single sample is only reported (`8feac51`) |
| (found in the gate) `ai-no-side-effects` in the full suite | The robot supervisor of that test's app paused a robot the tracing test had left running, and raised an alert, during the hostile turn | The fingerprint test turns the supervisor and alert evaluation off (not part of the AI path); the tracing test pauses its robot (`4911631`) |

## Gate

This gate ran on 2026-09-27 on the final code, with the machine to itself (no other session, no
mutation run in parallel). It used the default databases (`kora_test`, `kora_e2e`) and ports. **No
retries anywhere:** Playwright `retries: 0`, and every command ran once per listed run. Logs are in
`r6fix/gate/`.

| Check | Result |
|---|---|
| `pnpm build` | pass (7/7 tasks) |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm format:check` | pass (whole repo) |
| `pnpm test` | pass: domain 221, api 250 (unit coverage 99.1 % lines), web 107, ui 125, market-data 72, sdk 16, bot-runner 12, ai-evals 4, quant 186 (97.5 %) |
| `pnpm --filter @kora/api test:integration`, run 1 | **50 files / 321 tests passed**, coverage 92.3 % lines / 82.7 % branches / 96.0 % functions, every floor met |
| run 2 | 50 / 321 passed, floors met |
| run 3 | 50 / 321 passed, floors met |
| `pnpm test:e2e`, run 1 | **92 passed**, 0 failed, 0 flaky (6.1 min), tick-to-paint p95 43.2 ms |
| run 2 | 92 passed, 0 failed (6.3 min), p95 50.2 ms |
| run 3 | 92 passed, 0 failed (6.1 min), p95 48.0 ms |
| `pnpm py:check` | pass (ruff, mypy --strict, 186 tests, 97.51 %) |
| `pnpm evals` | 133/133, RESULT PASS (scripted-provider regression) |
| `pnpm --filter @kora/web i18n:check` | pass (8 tests) |
| `pnpm contrast` | 152/152 pairs |
| SAST (`scripts/security/sast.sh`, Semgrep 422 rules) | 0 findings over 907 files |
| `pnpm audit --prod --audit-level high` | no known vulnerabilities |
| `pip-audit` (quant venv, editable skipped) | no known vulnerabilities |
| Secrets over git history (`scripts/security/secrets-history.py`) | 364 findings, 364 reviewed, 0 unreviewed (two new fingerprints reviewed: the audit KAT hash and the mock API key) |
| Chaos drill (`node scripts/chaos/run.mjs`, own database) | **41/41 checks passed** (142 s), including the new stale-badge and all-accounts reconciliation steps |

One e2e run before these failed: the two visual tests found real fixture drift through the new R6-16
check (see R6-16). It was fixed in `a7ffebd`, and the three runs above are after that commit. The
build, lint, typecheck, format, unit and integration results are from the same tree except for that
e2e-only fixture change and the chaos script.

## Open

| Item | Owner | Why not here |
|---|---|---|
| Response schemas in OpenAPI for `GET /ai/strip`, `/calendar`, `/me/watchlists`, `/price-alerts` | api owner (S3/S4) | Needs the controllers to declare their response DTOs; the fixture check lists them exactly and fails once one is added |
| A `READ ONLY` transaction around copilot tool dispatch (defence in depth beyond the two R6-02 tests) | R4 / AI owner | The draft tools must write; needs a split dispatch path |
| Unit coverage allowlists as `src/**` with reasoned excludes (R6-06 suggestion) | S10 | The integration gate now measures all of the api; the web allowlist stays as it is |
| Live evals | Sponsor (API key, billed model, OQ-A2) | `ai-evals-live` runs once the secret and variable exist |
| ZAP baseline | S9 | Runs in `release.yml` after the first staging deploy |
