# IRTC register — independent review, correction and re-verification (RC-1)

- **Committee:** Independent Review & Test Committee (CHARTER §6), seats R1–R6. Report line: Sponsor, through the
  Project Owner.
- **Re-verification lead:** independent of the reviewers' correctors (did not write any of the R1–R6 corrections).
- **Branch:** `claude/magical-newton-yyxga6`. Re-verification started at `57513bc` (all IRTC corrections merged)
  and ended at the commit that adds this register.
- **Date:** 2026-09-27/28.
- **Sources:** seat reports `R1-security.md` … `R6-tests.md` and their reproduction scripts (session scratchpad
  `irtc/r1` … `irtc/r6`); correction reports [`IRTC-R1-fixes.md`](IRTC-R1-fixes.md) …
  [`IRTC-R6-fixes.md`](IRTC-R6-fixes.md).
- **Re-verification evidence:** session scratchpad `irtc/rv/` (one folder per seat with the adapted scripts and
  their logs, `rv/r6/logs` for the mutation runs, `rv/fix` for the before/after logs of the re-verification fixes,
  `rv/gate` for the final gate logs).

## 1. Method

For every Critical, High and Medium finding the **original reproduction was re-run against the current code**,
adapted only where the API had changed (the appropriateness attempt now carries the risk warning, R4-09; privileged
role grants are four-eyes, R4-02; Redis prefixes and `KORA_ROBOT_CTL_PREFIX` are per run, R6). One **bypass
variant** was tried for every Critical and High finding (and for several Mediums). Lows were sampled (at least one
per seat). Verdicts:

- **FIXED**: the reproduction (and the variant) no longer reproduces, and a regression test exists and ran green in
  the final gate below;
- **PARTIAL**: the original reproduction is fixed but a variant still reproduces the defect;
- **NOT FIXED**: the original reproduction still reproduces.

Every PARTIAL was then corrected in this step (regression test failing before, passing after), and re-run.

Environment: private stack only — databases `kora_irtc_rv` (live API), `kora_irtc_rv_r2` (vitest harness),
`kora_irtc_rv_test` (integration and mutation runs), `kora_irtc_rv_e2e`; ports api 4070, web 3070, quant 8070, bot
runner 4170 (alternate api 4071 in the harness); Redis prefixes `irtcrv:*`, `KORA_ROBOT_CTL_PREFIX=irtcrv:`. No
shared service was stopped or reset. Scripted AI provider (reference and adversarial personas).

## 2. Summary by seat and severity

"Fixed" includes the three findings completed during re-verification (R1-02 = R4-02, R4-04, R5-08). "Open" are Lows
logged with an owner. No finding was refuted by the correctors or by re-verification.

| Seat | Severity | Found | Confirmed | Refuted | Fixed | Owner-accepted | Open |
|---|---|---|---|---|---|---|---|
| R1 security | High | 2 | 2 | 0 | 2 | 0 | 0 |
| | Medium | 4 | 4 | 0 | 4 | 0 | 0 |
| | Low | 5 | 5 | 0 | 5 | 0 | 0 |
| R2 trading | Critical | 2 | 2 | 0 | 2 | 0 | 0 |
| | High | 3 | 3 | 0 | 3 | 0 | 0 |
| | Medium | 10 | 10 | 0 | 10 | 0 | 0 |
| | Low | 10 | 10 | 0 | 6 | 0 | 4 |
| R3 quant | High | 5 | 5 | 0 | 5 | 0 | 0 |
| | Medium | 3 | 3 | 0 | 3 | 0 | 0 |
| | Low | 10 | 10 | 0 | 6 | 0 | 4 |
| R4 AI & compliance | High | 2 | 2 | 0 | 2 | 0 | 0 |
| | Medium | 8 | 8 | 0 | 8 | 0 | 0 |
| | Low | 11 | 11 | 0 | 10 | 0 | 1 |
| R5 frontend & a11y | High | 5 | 5 | 0 | 5 | 0 | 0 |
| | Medium | 11 | 11 | 0 | 11 | 0 | 0 |
| | Low | 10 | 10 | 0 | 7 | 0 | 3 |
| R6 test integrity | High | 3 | 3 | 0 | 3 | 0 | 0 |
| | Medium | 4 | 4 | 0 | 4 | 0 | 0 |
| | Low | 9 | 9 | 0 | 9 | 0 | 0 |
| Re-verification (new) | Low | 2 | 2 | 0 | 2 | 0 | 0 |
| **Total** | | **119** | **119** | **0** | **107** | **0** | **12** |

By severity: Critical 2/2 fixed · High 20/20 fixed · Medium 40/40 fixed · Low 45/57 fixed, 12 open (owners below).

### Re-verification verdicts before the re-verification fixes (Critical/High/Medium)

| Seat | FIXED | PARTIAL | NOT FIXED |
|---|---|---|---|
| R1 | 5 | 1 (R1-02) | 0 |
| R2 | 15 | 0 | 0 |
| R3 | 8 | 0 | 0 |
| R4 | 8 | 2 (R4-02, R4-04) | 0 |
| R5 | 15 | 1 (R5-08) | 0 |
| R6 | 7 | 0 | 0 |

After the re-verification fixes (section 5) every Critical, High and Medium finding is FIXED.

## 3. Findings

Legend: **Re-verification** gives what was re-run and what it showed (orig = original reproduction; var = bypass
variant). Commits are on this branch. "Regression" is the test that fails on the defect; all ran green in the final
gate (section 8).

### R1 — application security

| ID | Sev | Title | Verdict | Fix commit(s) | Regression test | Re-verification | Owner if open |
|---|---|---|---|---|---|---|---|
| R1-01 | High | TOTP lockout reset by every correct password | Confirmed | `e708721` | `auth-bruteforce.int.test.ts` (R1-01) | **FIXED.** orig: 3 × 9 wrong codes → `403 mfa_locked` from the 6th, correct code refused. var: 3 wrong step-up codes (stolen session) + 3 wrong login codes → locked at 5; 15 wrong codes fired in parallel → 4 evaluated, 11 `mfa_locked` (row lock holds) | |
| R1-02 | High | One admin defeats four-eyes with a self-made approver | Confirmed | `3d2fefa` (R4 corrector), **`c600f67` (re-verification)** | `role-grants.int.test.ts` (sock-puppet + "reverse direction"), domain `four-eyes.test.ts`, `promotion.int.test.ts` (R1-02) | **PARTIAL → FIXED.** orig: grant → 202 pending, self-approval 403, self-grant 403, puppet approving the granter → 403. var (reproduced): A requests admin for puppet P2, honest admin B approves once; P2 requests an MFA reset of a victim and **A approves → 200, victim MFA removed**; A also approves P2's role grants; the robot risk sign-off had no independence check at all. Fixed by the symmetric rule; re-run → 403 `approver_not_independent`, victim keeps MFA | |
| R1-03 | Medium | Open WebSocket keeps roles after logout / demotion / disable | Confirmed | `491eecd` | `ws-revocation.int.test.ts` | **FIXED.** orig: logout → socket closed 4401, later subscribe impossible. demotion via admin API → 4401, 0 victim order events. var: user disabled out of band in the DB → closed by the sweep after 4.8 s | |
| R1-04 | Medium | Lockout DoS and account enumeration | Confirmed | `e708721` | `auth-bruteforce.int.test.ts` (R1-04) | **FIXED.** orig: 12 attempts on an existing and an unknown e-mail give identical answers (5 × 401 then 429); owner signs in from another IP. var: response-time enumeration — medians 55.8 ms vs 57.8 ms, no signal. Residual (OQ-SA1): an owner behind the attacker's address is backed off ≤ 15 min | |
| R1-05 | Medium | Every web client shares one rate-limit bucket behind `/api` | Confirmed | `2e0a1f1` | `rate-limit-attribution.int.test.ts`, `peer-address.test.ts`, `proxy-attribution.spec.ts` | **FIXED** (through the real web proxy). orig: client B's first sign-in after A's 20 → 401 (not 429). Distinct peers: A (127.0.0.5) hits the per-IP ceiling at 100, B (127.0.0.6) unaffected. var: A spoofing `X-Forwarded-For`, `x-kora-peer-addr`, `x-real-ip` stays 429 | |
| R1-06 | Medium | Post-login open redirect `next=/\evil` | Confirmed | `b66260c`, `47d3ea1` | `safe-next.test.ts`, e2e `auth.spec.ts` | **FIXED** (Chromium, real sign-in). orig `/%5Cevil…`, `/%09/evil…` and var `/.//evil`, `/..//evil`, `/%2e//evil`, `/%252F%252Fevil`, `/%E3%80%80/evil`, `/@evil`, `/ /evil`: never left the origin | |
| R1-07 | Low | Step-up TOTP without lockout | Confirmed | `e708721` | `auth-bruteforce.int.test.ts` (R1-07) | **FIXED** (sampled): 5 wrong step-up codes lock the factor and end the session (`/me` → 401). Observation: a lock *completed* by a login-step failure after stolen-session step-up failures does not end sessions (backlog B-1105) | |
| R1-08 | Low | `/audit/verify` open to all | Confirmed | `626ae26` | `audit-verify-access.int.test.ts` | **FIXED** (sampled): trader gets `scope: own`, auditor the chain | |
| R1-09 | Low | Auditor passing the assessment → 500 | Confirmed | `3d36a79` | `appropriateness-abuse.int.test.ts` (R1-09) | **FIXED** (sampled): 409 `segregation_of_duties`, roles unchanged | |
| R1-10 | Low | Client-set `source: ai-draft-accepted` | Confirmed | `952fa65` (R4-06) | `ai.int.test.ts` "IRTC R4-06" | **FIXED** (sampled): 400 `ai_draft_required` | |
| R1-11 | Low | Hardening gaps (Redis auth, docs, dev IdP, CSV, sybil) | Confirmed | `1409d3d`, `3d36a79` | `config.test.ts`, `runner.test.ts`, `api-docs-exposure.int.test.ts`, `sim.test.ts`, `appropriateness-abuse.int.test.ts` | Fixed per the corrector; tests green in the gate (not re-run by hand) | |

### R2 — trading and money correctness

| ID | Sev | Title | Verdict | Fix commit(s) | Regression test | Re-verification | Owner if open |
|---|---|---|---|---|---|---|---|
| R2-01 | Critical | Amend bypasses every pre-trade limit | Confirmed | `79a7852` | `irtc-r2.int.test.ts` R2-01 | **FIXED.** orig: `PATCH qty=50000000` → 422, only 10,000 fills. var (price amend): long 1.8M, buy limit 60k below market amended to a marketable price → 422 `MAX_POSITION`, gross stays 1.95M ≤ 2M | |
| R2-14 | Critical | Non-USD accounts: stops, closes, flatten held on stale FX | Confirmed | `8993f68`, `c293ccb` | `irtc-r2.int.test.ts` R2-14, domain `irtc-r2.test.ts` | **FIXED.** orig (Saturday, EURUSD from Friday): the EUR account's stop fired, position flat. var: take-profit fired on the weekend; a reduce-only close filled; new exposure on the stale rate refused | |
| R2-02 | High | Limit made marketable fills at its limit as maker; post-only takes | Confirmed | `8993f68`, `79a7852` | `irtc-r2.int.test.ts` R2-02 (×2) | **FIXED.** orig: post-only amend across → 422; fresh 1.09400 limit fills at the touch 1.08421. var: post-only amended to exactly the ask → `POST_ONLY_WOULD_TAKE`; a plain limit amended across a 3-level book walks it as taker (1.08421/1.08425), never at its limit | |
| R2-03 | High | Several "reducing" orders flip past the limits | Confirmed | `79a7852`, `1c1a94f` | `irtc-r2.int.test.ts` R2-03 | **FIXED.** orig: sells 4 and 5 rejected `MAX_POSITION`; final −1.8M, gross 1.96M ≤ 2M, leverage 18.8. var (limits + stops + trailing): 5 of 8 rejected, final exposure within position and leverage limits | |
| R2-04 | High | Novice can cancel or widen the mandatory stop | Confirmed | `79a7852` | `irtc-r2.int.test.ts` R2-04 | **FIXED.** orig: widen and cancel → 422. var: novice-only user switched to the Pro view: cancel and shrink → 422; cancel-all and kill-switch scope 2 keep the stop | |
| R2-05 | Medium | Base-currency change relabels cash; unit-less limits | Confirmed | `18ec757` | `irtc-r2.int.test.ts` R2-05 | **FIXED:** GBP 79,106.41 / JPY 14,821,500 with a reversal journal per currency; limits converted; CHF without an FX route → 409 | |
| R2-06 | Medium | Minimum commission per depth level | Confirmed | `8993f68`, `c293ccb` | `irtc-r2.int.test.ts` R2-06, domain property | **FIXED:** 300 AAPL over 3 levels charged 1.50 total (= preview); 10 over 10 levels 1.00 | |
| R2-08 | Medium | Daily-loss baseline = first valuation of the day | Confirmed | `18ec757`, `637575a` | `irtc-r2.int.test.ts` R2-08 | **FIXED** with the engine sweep running at the UTC boundary (orig scenario → 422 `DAILY_LOSS_LIMIT`, `dayPnl −7,371`). The unmodified harness disables the engine, so it still shows the old result — by design the control is the boundary sweep | |
| R2-09 | Medium | Resume TOCTOU lifts a firm halt | Confirmed | `08e0e6f` | `irtc-r2.int.test.ts` R2-09 | **FIXED:** forced interleaving → 409, still halted | |
| R2-10 | Medium | Sticky, process-global volatility slippage | Confirmed | `3daa8a8` | `irtc-r2.int.test.ts` R2-10 | **FIXED:** 10 min and 6 unchanged quotes after a jump the sell fills at the bid (1.09419) | |
| R2-11 | Medium | Trailing-distance amend ineffective | Confirmed | `79a7852` | `irtc-r2.int.test.ts` R2-11 | **FIXED:** stop moves to 1.08369 at once and fills on the drop | |
| R2-12 | Medium | Kill switch scope 2 strips protective stops | Confirmed | `08e0e6f` | `irtc-r2.int.test.ts` R2-12 | **FIXED:** 0 cancelled, stop kept (OQ-T1) | |
| R2-19 | Medium | DAY orders on 24 h venues live to Friday | Confirmed | `79a7852` | `irtc-r2.int.test.ts` R2-19 | **FIXED:** EURUSD Monday → Monday 21:00Z; US500 → Wednesday 21:00Z; exchange venues unchanged | |
| R2-20 | Medium | No margin close-out | Confirmed | `637575a`, `1c1a94f` | `irtc-r2.int.test.ts` R2-20, `trading.unit.test.ts` | **FIXED** (independent check): 1.8M long, level 38 % → `risk.margin_call` + `risk.margin_closeout`, position closed by a `margin-closeout` order (OQ-B3) | |
| R2-21 | Medium | Resting orders never re-checked before a fill | Confirmed | `8993f68`, `c293ccb` | `irtc-r2.int.test.ts` R2-21, domain R2-21 | **FIXED** (independent check): resting buy after the daily limit was hit → cancelled `risk_recheck:DAILY_LOSS_LIMIT`, 0 filled | |
| R2-07 | Low | Fractional minor-unit charges | Confirmed | `8993f68` | `irtc-r2.int.test.ts` R2-07 | **FIXED** (sampled): JPY commission whole yen | |
| R2-13 | Low | Session override with `NODE_ENV=production` | Confirmed | `637575a` | `trading.unit.test.ts` R2-13 | **FIXED** (sampled): refused | |
| R2-15 | Low | Split orders reuse visible liquidity | Confirmed | `8993f68` | `irtc-r2.int.test.ts` R2-15 | **FIXED** (sampled): five 100k IOCs walk 1.08421 → 1.08461 | |
| R2-16 | Low | Loose order shapes | Confirmed | `c293ccb` | domain R2-16 | **FIXED** (sampled): IOC/FOK stops and trailing with prices → 400 | |
| R2-18 | Low | Zero own limit → NaN | Confirmed | `18ec757` | `irtc-r2.int.test.ts` R2-18 | **FIXED** (sampled): 400 | |
| R2-26 | Low | Flatten reason mislabelled; robot amends while halted | Confirmed | `08e0e6f`, `79a7852` | `irtc-r2.int.test.ts` R2-26 | Fixed per the corrector; green in the gate | |
| R2-22 | Low | Robot stop cancelled by manual netting | Confirmed (code) | — | — | Open (logged) | S4 / S2, B-408 |
| R2-23 | Low | Swap roll at fixed UTC hour, missing marks | Confirmed (code) | — | — | Open (logged) | S2 / S4, B-304 |
| R2-24 | Low | CFD-style financing everywhere; unrestricted shorts | Confirmed (code) | — | — | Open (policy) | S8 → Sponsor, OQ-R5 |
| R2-25 | Low | Robot context maths in JS `Number` | Confirmed (code) | — | — | Open (logged; no ledger impact) | S5 / S3 |

### R3 — quant and statistics

| ID | Sev | Title | Verdict | Fix commit(s) | Regression test | Re-verification | Owner if open |
|---|---|---|---|---|---|---|---|
| R3-01 | High | Optimiser selects on the OOS segment | Confirmed | `85cbcde` | `test_bt_selection.py`, `strategies.int.test.ts` | **FIXED.** orig (`e_opt.py`, adapted to `best.holdout`): 6 random walks, 144 combos → reported holdout Sharpe mean −1.11 (review: best "OOS" 5.18), its rank among the top-30 holdouts spread 2…28 (no selection on the holdout). var: sensitivity heatmap cells identical when every holdout bar is replaced (3/3) | |
| R3-02 | High | Gameable promotion gate and trial count | Confirmed | `43e0858` | `test_bt_evidence.py`, `evidence.test.ts`, `strategies.int.test.ts`, `promotion.int.test.ts` | **FIXED** (at the API). orig shopping: `oosFraction 0.2`, `spreadTicks 0`, custom `from` → +1 trial each, not eligible. var (symbol list): subset and duplicated symbols → +1 trial, `symbols_override`; reordered = same data (0 trials, same Sharpe); lowercase → 400. var (capital 7k / 1M): identical OOS Sharpe, no shopping gain | |
| R3-03 | High | Edge t-test counts overlapping, correlated predictions | Confirmed | `31bad18`, `f0c1596` | `edge-stat.test.ts`, `test_scanner_irtc.py` | **FIXED.** orig (`e_calib.py 40 72`, rows fed to the current `clusteredEdge`): replays deduplicate (216 → 240 rows after 72 scans), clustered t sd 1.02/1.06 (review: 5.66), "edge positive" 0/40 one scan, 2/40 accumulated (review: 28 %) | |
| R3-04 | High | Cross-sectional features leak other instruments' future bars | Confirmed | `d7bf993` | `test_scanner_irtc.py` | **FIXED.** orig (B stale by 4 bars): skill 0/8, hit 0.482. var (B halted 4 bars every 300 inside the window): skill 0/6 | |
| R3-05 | High | Vacuous scanner guard; sparse backtester guard | Confirmed | `8f5810e` | `test_scanner_irtc.py`, `test_bt_guard.py`, `intel.unit.test.ts` | **FIXED.** orig: next-bar leak caught with 2 checkpoints; pivot leak passes 0/40. var (1-bar leak on 5 % of bars only): scanner guard caught 20/20, backtester guard passed 0/40 | |
| R3-06 | Medium | `bars_per_year` assumes 24/7 | Confirmed | `1a7746a` | `test_bt_calendar.py`, `sessions.test.ts`, `strategies.int.test.ts` | **FIXED:** weekday daily bars at the calendar figure → 20.1 % (24/7 figure 23.9 %); per-instrument figure used by the engine | |
| R3-07 | Medium | MC ignores an R cost on % returns but echoes it | Confirmed | `883f1a9` | `test_sim_irtc.py`, `sim.int.test.ts` | **FIXED:** refused with a message | |
| R3-08 | Medium | VaR/correlation aligned by position; forming bar | Confirmed | `df78ee5` | `risk-analytics.test.ts` | **FIXED:** current TS code on the review's data: hedged VaR 1,194.17, long/long 7,061.77 = the date-aligned ground truth (shipped was 5,136 / 4,993); forming bar dropped | |
| R3-09 | Low | Isotonic outputs 0 or 1 | Confirmed | `447b27b` | `test_scanner_irtc.py` | **FIXED** (sampled): max 0.99 | |
| R3-10 | Low | `hasSkill` unreachable, unused | Confirmed | superseded by R3-03 | — | Closed (UI gate is the R3-03 statistic) | |
| R3-11 | Low | Calibration event ≠ prediction | Confirmed | — | — | Open | S5 |
| R3-12 | Low | Calibrator leakage / mismatch | Confirmed | `dd6e43c` | `test_scanner_irtc.py` | Fixed per the corrector; green in the gate | |
| R3-13 | Low | Flat-window RSI 100 vs 50 | Confirmed | `1ad1364` | `test_bt_indicators.py` | Fixed; green in the gate | |
| R3-14 | Low | Kelly with no edge → flat band | Confirmed | — | — | Open (UX decision) | S5 |
| R3-15 | Low | Metric edge cases | Confirmed | `ad32a5d` | `test_bt_metrics_costs.py` | **FIXED** (sampled): 0 drawdown days, no CAGR on 1 day | |
| R3-16 | Low | Optimistic exit fills | Confirmed | — | — | Open | S2 / S5 |
| R3-17 | Low | VWAP resets at UTC day | Confirmed | — | — | Open | S6 |
| R3-18 | Low | Tracking replays with the guard off | Confirmed | `43262ec` | `robots.unit.test.ts` | Fixed; green in the gate | |

### R4 — AI safety and compliance

| ID | Sev | Title | Verdict | Fix commit(s) | Regression test | Re-verification | Owner if open |
|---|---|---|---|---|---|---|---|
| R4-01 | High | Pro SSE streams unguarded model output | Confirmed | `f0aa032`, `6d37659`, (+`768627c`) | `irtc-r4.unit.test.ts` R4-01, `ai.int.test.ts` "IRTC R4-01", evals `stream_guarded` | **FIXED.** orig (adversarial persona, `/ai/chat`): only "Done! " streamed; final guarded, `executionClaim`. var (`/intel/trends/BTCUSD/explain` SSE): same, no unguarded delta. The paraphrases found under R4-04 would have streamed too; closed by `768627c` | |
| R4-02 | High | One admin defeats four-eyes | Confirmed | `3d2fefa`, **`c600f67`** | as R1-02 | **PARTIAL → FIXED** (same root as R1-02; t2 re-run: trader grant without assessment → 202 pending with `appropriatenessOverride`) | |
| R4-03 | Medium | Numeric fidelity satisfied by noise; calibration unenforced | Confirmed | `f4dfedc` | `irtc-r4.unit.test.ts` R4-03, evals `guard-num-*` | **FIXED:** 0/90 integer percentages grounded by ids/timestamps (review 63–71); `57% (n=87)`, `63% (n=14)` from `rsi14`, `fifty-seven percent`, `５７％`, `٩٩٪`, `97%` from a news title → flagged. Observation: small-integer odds ("3 in 4") pass (backlog B-1106) | |
| R4-04 | Medium | Keyword guards on un-normalised text | Confirmed | `f4dfedc`, **`768627c`** | `irtc-r4.unit.test.ts` R4-04 (incl. "re-verify") | **PARTIAL → FIXED.** orig: the review's 12 phrasings now flagged. var (reproduced): "Your position is now open.", "Consider going long here.", "Grab some ETH while it is cheap.", "A long position looks attractive right now." passed; patterns widened (8 new cases, 3 no-false-positive cases), evals 133/133 | |
| R4-05 | Medium | Untrusted free text reaches the model unwrapped | Confirmed | `f4dfedc`, `e7b7def` | `irtc-r4.unit.test.ts` R4-05, `intel.unit.test.ts` | **FIXED:** `description`, `robotName` wrapped in tool results; `translatedTitle`, `source`, `url`, `summary` wrapped in grounding | |
| R4-06 | Medium | Draft acceptance not bound to the draft | Confirmed | `952fa65`, `a288c2b` | `ai.int.test.ts` "IRTC R4-06" | **FIXED:** client label → 400; opposite side → `manual`; accepting two drafts with an unrelated order → `order_mismatch`. var: two concurrent orders from one draft → one `ai-draft-accepted`, the other 409 | |
| R4-07 | Medium | Audit anchors self-certifying; truncation invisible | Confirmed | `61c4e18` | `anchors.unit.test.ts`, `internal-audit.int.test.ts` "IRTC R4-07" | **FIXED:** truncation into the anchored range → `valid:false`, `truncated_after_anchor`; attacker-keyed anchor → `signatureValid:false, trustedKey:false`. var (insider also deletes every anchor row): `/audit/verify` alone says valid, internal audit's WORM read-back reports `missingInDatabase:1, notMatchingChain:1`. Residual: events after the latest anchor are unwitnessed until the next (daily) anchor | |
| R4-08 | Medium | AI suggestion content never recorded | Confirmed | `c63f809` | `ai.int.test.ts`, `intel.int.test.ts` | **FIXED:** `ai.request.answerHash` = SHA-256 of the answer shown | |
| R4-09 | Medium | Traders never acknowledge the risk warning | Confirmed | `ea82320`, `059de18` | `risk-warning-gate.int.test.ts` | **FIXED:** trader's pass records an `appropriateness` acknowledgement; admin-granted staff without one → 422 `DISCLOSURE_NOT_ACKNOWLEDGED`; attempt without the warning → 400; var: forged content hash → 409. Scope/wording for Compliance: OQ-C3 | |
| R4-10 | Medium | `trader` without the assessment | Confirmed | `3d2fefa` | `role-grants.int.test.ts` (trader), `user-provisioner.test.ts` | **FIXED:** 400 without reason; 202 pending with `appropriatenessOverride: true` | |
| R4-11 | Low | PII in untrusted blocks; public salt | Confirmed | `f4dfedc` | `irtc-r4.unit.test.ts` R4-11 | **FIXED** (sampled): e-mail, IBAN, phone redacted | |
| R4-12 | Low | Test providers with `NODE_ENV=production` | Confirmed | `f4dfedc`, `fea3032` | `irtc-r4.unit.test.ts` R4-12 | **FIXED** (sampled): provider `anthropic` | |
| R4-13 | Low | Subject-access export incomplete | Confirmed | `f437a43` | `compliance.int.test.ts` | Fixed; green in the gate | |
| R4-14 | Low | Delimiter look-alikes | Confirmed | `f4dfedc` | `irtc-r4.unit.test.ts` R4-14 | **FIXED** (sampled): full-width, Cyrillic, `</tool_result>` neutralised | |
| R4-15 | Low | Model rationale verbatim; unbounded draft size | Confirmed | `80be2db` | `ai.int.test.ts` | Fixed; green in the gate | |
| R4-16 | Low | Static guard coverage | Confirmed | `10c53de` | `ai.static.test.ts` | Fixed (see also R6-02 hardening `01e16e5`) | |
| R4-17 | Low | Reject without independence; human drafts as AI | Confirmed | `80be2db`, `3d2fefa` | `role-grants.int.test.ts`, `ai.int.test.ts` | **FIXED** (sampled): puppet reject → 403 | |
| R4-18 | Low | Simulator hard-codes `[XX]%` | Confirmed | `463ca6a` | `retail-loss.test.ts` | Fixed; green in the gate | |
| R4-19 | Low | Narrow gamification lint | Confirmed | `e617cf2` | `novice.test.ts` | Fixed; green in the gate | |
| R4-20 | Low | Budget overshoot; shared news budget | Confirmed | `b490133` | `budget.unit.test.ts` | Fixed; green in the gate | |
| R4-21 | Low | Assessment feedback as answer oracle | Confirmed | — | — | Open (policy) | Compliance (S8), OQ-C4 |

### R5 — frontend, UX and accessibility

| ID | Sev | Title | Verdict | Fix commit(s) | Regression test | Re-verification | Owner if open |
|---|---|---|---|---|---|---|---|
| R5-01 | High | Confirm dialog uses a stale preview | Confirmed | `f1e7f55` | e2e `irtc-r5.spec.ts` R5-01 | **FIXED** (Chromium, preview delayed 1.5 s). orig (1,000 → 900,000 + Ctrl+Enter): dialog "Confirm buy 900,000", notional 974,385.00 = the fresh preview of the placed body. var (side changed, 60k above and 1k below threshold): dialog "Confirm sell …" with the sell preview, body `side: sell` | |
| R5-02 | High | Blotter Mark / P&L frozen, three P&L figures | Confirmed | `de444d7`, `4c921b6` | e2e R5-02, `live-book.test.ts` | **FIXED:** 8 samples: row Mark and P&L move with the API (e.g. 65,213.0 / +30.02 vs API 65,213.7 / +31.42) and agree with the top bar | |
| R5-03 | High | Status bar hard-codes "Robots: none" | Confirmed | `a3c337a` | e2e R5-03, `robots.test.ts` | **FIXED:** "Robots: none" → "Robots: 1 running" after paper-run | |
| R5-04 | High | Hold-to-confirm unusable by AT; taps give nothing | Confirmed | `5644f24` | `HoldToConfirm.a11y.test.tsx`, e2e R5-04 | **FIXED:** one tap opens "Stop everything: choose what to stop"; `element.click()` opens the Pro kill-switch menu; French strings | |
| R5-05 | High | Preview live region floods screen readers | Confirmed | `f1e7f55`, `7bad8dd` | e2e R5-05, `ticket-preview.test.ts` | **FIXED:** 0 live-region announcements in 10 s of ticks with a 200-pip stop (review: 15); one short announcement after an edit | |
| R5-06 | Medium | Top bar freezes silently on account errors | Confirmed | `de444d7` | e2e R5-06 | **FIXED:** "⚠ Stale figures as of 00:05:01" after 12 s of 503 | |
| R5-07 | Medium | Fill price with 40 decimals | Confirmed | `f1e7f55` | e2e R5-01, `ticket-preview.test.ts` | **FIXED:** "at 1.08265" | |
| R5-08 | Medium | "2,500" read as 2.50 | Confirmed | `27739a9`, **`7c31e7c`** | `NumberInput.locale.test.tsx` (incl. key-by-key), e2e R5-08 (`pressSequentially`) | **PARTIAL → FIXED.** orig with `fill`: 2,500 → 2500.00. var (reproduced): **typed key by key, "2," cleared the field and the amount became 500** (novice amount and Pro quantity). Fixed; re-run in Chromium: steps 2 → 2, → 2,5 → 2,50 → 2,500 → 2500.00; French "2 500,5" → 2500,50 | |
| R5-09 | Medium | Reflow failures at 320 px | Confirmed | `0d2f5ea` | e2e R5-09 | **FIXED:** Pro /settings, /audit and FR novice /home, /practice, /settings scroll width 320 | |
| R5-10 | Medium | Novice-only users promised Pro features; blank Pro pages | Confirmed | `712f7ee`, `6ecc46d` | e2e R5-10 | **FIXED:** honest note about simple-view rules + assessment link; /terminal in the simple view explains itself (OQ-UX2) | |
| R5-11 | Medium | Portfolio placeholder | Confirmed | `6a98424` | e2e R5-11 | **FIXED:** real positions table | |
| R5-12 | Medium | English on French novice screens; small radios | Confirmed | `712f7ee` | e2e R5-12, `i18n.test.ts` | **FIXED:** French assessment and titles, answer rows 56–80 px (OQ-UX3: Compliance review) | |
| R5-13 | Medium | Pro views break in the light theme | Confirmed | `0d2f5ea` | e2e R5-13 | **FIXED:** kill switch 24 px, IBM Plex Mono numbers (OQ-UX1) | |
| R5-14 | Medium | No visible focus on `<summary>` | Confirmed | `0d2f5ea` | e2e R5-14 | **FIXED:** 2 px solid focus ring | |
| R5-15 | Medium | Colour convention partly applied | Confirmed | `0d2f5ea` | e2e R5-15, `tokens.test.ts`, contrast | **FIXED:** `red_up_asia` changes `--k-up` and `--k-up-surface`; `--k-ok` unchanged | |
| R5-16 | Medium | Risk bars fail non-text contrast | Confirmed | `0d2f5ea` | e2e R5-14/R5-16, `tokens.test.ts` | **FIXED:** visible "Risk level n of 5"; empty segments outlined #857F73 | |
| R5-17 | Low | CSP refuses Next.js preload links | Confirmed | — | — | Open: re-verified still present (3 refusals on /terminal) | S9 (CSP) |
| R5-18 | Low | Chart blank on an invalid language tag | Confirmed | `4d15ba5` | e2e R5-18, `irtc-r5-lows.test.ts` | **FIXED** (sampled): `en-US@posix`, 0 page errors, chart drawn | |
| R5-19 | Low | Direction glyph on zero | Confirmed | `4d15ba5` | `irtc-r5-lows.test.ts` | Fixed; green in the gate | |
| R5-20 | Low | Review silently changes the amount | Confirmed | `52cf5d4` | `novice.spec.ts` | Fixed; green in the gate | |
| R5-21 | Low | Pro targets below 24 px | Confirmed | `662c710` | e2e R5-21 | Fixed except the AI strip "Why?" toggle | S7 / S6 (AI strip) |
| R5-22 | Low | Radar empty state | Confirmed | `662c710` | e2e R5-22 | Fixed; green in the gate | |
| R5-23 | Low | Simulator layout polish | Confirmed | `662c710` | manual | Partly fixed; page height and "Run projection" fold open | S6 |
| R5-24 | Low | Promotion checklist semantics | Confirmed | `662c710` | `PromotionChecklist.test.tsx` | Fixed; green in the gate | |
| R5-25 | Low | Governance routes in the Novice shell | Confirmed | `712f7ee`, `7bad8dd` | e2e R5-25 | Fixed; green in the gate | |
| R5-26 | Low | Practice chip hidden on phones; SSR theme | Confirmed | `52cf5d4`, `7bad8dd` | e2e R5-26 | Fixed (first page of a new browser still dark until hydration) | |

### R6 — test integrity and reliability

Mutation re-run: the reviewer's nine surviving mutants, adapted to the current code, plus seven variants, on a
scratch copy of HEAD (`rv/r6/mutate-rv.py`, baseline green first). All 16 killed after re-verification.

| ID | Sev | Title | Verdict | Fix commit(s) | Regression test | Re-verification | Owner if open |
|---|---|---|---|---|---|---|---|
| R6-01 | High | Audit hash: no KAT, no field coverage | Confirmed | `00b64f0` | domain `audit.test.ts` (KAT, fields), `audit.int.test.ts` (8 columns) | **FIXED:** AUD-1 (`actor_id`) and AUD-2 (`ts`) killed by the domain suite; var AUD-4 (`entity_id`) killed | |
| R6-02 | High | "AI never executes" tests too narrow | Confirmed | `2763b33`, `4911631`, **`01e16e5`** | `ai-no-side-effects.int.test.ts`, `ai.static.test.ts` | **FIXED.** AI-1 and AI-3 (adapted to `read-ports.ts`) killed by the static scan. var: a write through `Reflect.get(this.accounts, 'update' + 'Settings')` survived the static scan but was killed by the whole-database fingerprint; the static scan was hardened (`01e16e5`), and the variant is now killed by both | |
| R6-03 | High | Kill-switch flatten in a closed session untested | Confirmed | `e798d2c` | `irtc-r6.int.test.ts` R6-03 | **FIXED:** FS-2 killed; var FS-2k (only kill-switch orders skip the session check) killed | |
| R6-04 | Medium | Order-rate window length untested | Confirmed | `e798d2c` | `irtc-r6.int.test.ts` R6-04 | **FIXED:** RISK-5 (1 s) killed; var 1 hour killed | |
| R6-05 | Medium | Weekly loss limit untested at the API | Confirmed | `e798d2c` | `irtc-r6.int.test.ts` R6-05 | **FIXED:** RISK-9 killed; var month P&L = week P&L killed | |
| R6-06 | Medium | Coverage allowlists; production LLM adapter untested | Confirmed | `c963e18` | integration coverage floors, `anthropic.provider.test.ts` | **FIXED:** floors enforced in both gate integration runs (section 8); the Anthropic provider is in the unit coverage gate | |
| R6-07 | Medium | Eval gate cannot detect model regressions; overclaims | Confirmed | `4630e60` | CI config | **FIXED:** CI step labelled scripted regression, secrets-gated `ai-evals-live` job, plan 07 criterion 5 "Grafana: deferred" | |
| R6-08 | Low | Fat-finger on SL/TP untested | Confirmed | `e798d2c` | `irtc-r6.int.test.ts` R6-08 | **FIXED:** RISK-8 killed | |
| R6-09 | Low | Chaos checks that cannot fail | Confirmed | `deba43a`, `c04cd12` | chaos drill | Fixed per the corrector (drill 41/41, not re-run) | |
| R6-10 | Low | CI retries hide flakes | Confirmed | `f3971d8` | `playwright.config.ts` | **FIXED:** `retries: 0`; both gate e2e runs with no retries | |
| R6-11 | Low | `staleSymbols` untested | Confirmed | `e798d2c` | `irtc-r6.int.test.ts` R6-11 | **FIXED:** FS-7 killed | |
| R6-12 | Low | Test aids fail open without `KORA_ENV` | Confirmed | `fea3032` | unit "IRTC R6-12" | **FIXED** (sampled via R2-13 / R4-12) | |
| R6-13 | Low | Stale QA evidence | Confirmed | `57513bc` | — | Fixed | |
| R6-14 | Low | CI steps that do nothing; no Prettier check | Confirmed | `4630e60`, `d8e9903` | CI config | **FIXED:** `format:check` passes in the gate | |
| R6-15 | Low | Coupled dates; midnight straddle | Confirmed | `7892705` | `irtc-r6.int.test.ts` R6-15 | Fixed; green in the gate | |
| R6-16 | Low | Visual fixtures unvalidated | Confirmed | `93a5d47`, `a7ffebd` | `terminal-visual.spec.ts` | Fixed; green in the gate | |

### Found by re-verification

| ID | Sev | Title | Verdict | Fix commit | Regression test | Re-verification | Owner if open |
|---|---|---|---|---|---|---|---|
| RV-01 | Low | The ticket note of a copilot draft showed `<untrusted_data source="tool:note">…` markup (side effect of R4-05 wrapping `note` in every tool output) | Confirmed | `fd9324b` | `ai.unit.test.ts` "IRTC re-verify RV-01" | FIXED: the client gets the KORA-built note; the model still sees it wrapped | |
| RV-02 | Low | The hold-to-place description said "Market order above your confirmation threshold" for every market order, including small orders confirmed only for a missing stop | Confirmed | `83e2550` | `ticket-preview.test.ts` "IRTC re-verify RV-02" | FIXED: lists the server's confirmation reasons | |

## 4. Bypass attempts (one per Critical and High, several per Medium)

| Finding | Variant tried | Result |
|---|---|---|
| R1-01 | step-up failures + login failures interleaved; 15 parallel guesses on one MFA token | held (lock at 5; 4 evaluated in the burst) |
| R1-02 / R4-02 | reverse relation: requesting admin approves the puppet's requests; robot risk sign-off by a puppet risk officer | **bypass reproduced** → fixed `c600f67` |
| R1-03 | out-of-band DB disable | closed by the sweep (4.8 s) |
| R1-04 | response-time enumeration | no signal (55.8 vs 57.8 ms) |
| R1-05 | spoofed `X-Forwarded-For`, `x-kora-peer-addr`, `x-real-ip` | held (429) |
| R1-06 | seven extra encodings (dot segments, `%2e`, double-encoded `%2F`, ideographic space, `@`, space) | held |
| R2-01 | price amend instead of quantity | held (422 `MAX_POSITION`) |
| R2-14 | take-profit instead of stop; reduce-only close; new exposure on stale FX | held |
| R2-02 | post-only amended to exactly the ask; plain limit across a 3-level book | held |
| R2-03 | resting limits + stops + trailing stops together | held |
| R2-04 | novice-only user in the Pro view; cancel-all; qty shrink; kill switch scope 2 | held |
| R3-01 | sensitivity heatmap with a different holdout | held (identical cells) |
| R3-02 | symbol-list variation (reorder, duplicate, subset, lowercase); capital variation | held |
| R3-03 | 72 hourly re-scans on correlated no-skill walks through the current statistic | held (2/40 ≈ nominal) |
| R3-04 | interior halts instead of a stale end | held (0/6) |
| R3-05 | 1-bar leak on 5 % of bars | held (caught 20/20; passes 0/40) |
| R4-01 | intel explain SSE stream | held |
| R4-03 | full-width / Arabic digits, spaced "57 %", number words through `applyGuards` | held ("3 in 4" odds pass: backlog) |
| R4-04 | eight new paraphrases | **bypass reproduced** → fixed `768627c` |
| R4-06 | two concurrent orders from one draft | held (409) |
| R4-07 | insider deletes the anchors too | caught by the WORM read-back in internal audit |
| R4-09 | forged risk-warning content hash | held (409) |
| R5-01 | side change instead of quantity (above and below threshold) | held |
| R5-08 | typing key by key instead of filling | **bypass reproduced** → fixed `7c31e7c` |
| R6-01 | `entity_id` dropped from the hash | killed |
| R6-02 | `Reflect.get` write (evades the static scan) | killed by the fingerprint; static scan hardened `01e16e5` |
| R6-03 | only kill-switch orders skip the session check | killed |
| R6-04 / R6-05 | window 1 hour; month P&L = week P&L | killed |

## 5. Fixes made during re-verification

| Commit | Finding | Change | Test (before → after) |
|---|---|---|---|
| `c600f67` | R1-02, R4-02 | Four-eyes independence symmetric (decider may not have granted/approved any role of the requester); robot risk sign-off applies it (refused at sign-off; not counted in the checklist); ADR 0009 §4a | domain `four-eyes.test.ts` (null → `requester_granted_by_decider`), `role-grants.int.test.ts` (200 → 403), `promotion.int.test.ts` (201 → 403) |
| `768627c` | R4-04 (R4-01) | Wider execution-claim and suggestion patterns | `irtc-r4.unit.test.ts` (8 failing → pass), evals 133/133 |
| `01e16e5` | R6-02 | Static scan refuses `Reflect`, `Object.getOwnProperty*`, `.call/.apply/.bind` and aliased services in tool code | mutant AI-1r survives the old scan, killed by the new one |
| `7c31e7c` | R5-08 | `NumberInput` keeps an ambiguous intermediate text on screen | `NumberInput.locale.test.tsx` (`['2','','5','50','500']` → `['2','2,','2,5','2,50','2,500']`); e2e types with `pressSequentially` |
| `fd9324b` | RV-01 | Draft records keep the KORA-built output for the client | `ai.unit.test.ts` RV-01 (wrapped → plain) |
| `83e2550` | RV-02 | Hold-to-place description from the confirmation reasons | `ticket-preview.test.ts` RV-02 (fail → pass) |

## 6. Product Owner decisions under delegated Sponsor authority (CHARTER §7)

Recorded in [`docs/open-questions.md`](../open-questions.md) as "Decided by Product Owner (delegated Sponsor
authority)", each with its rationale, taken during the IRTC corrections:

| Row | Decision | Findings |
|---|---|---|
| OQ-SA1 | Second-factor lock 5 failures / 15 min doubling to 24 h; password back-off without hard lock | R1-01, R1-04, R1-07 |
| OQ-SA2 | Client-address attribution; 20/min per (IP, account), 5× per IP | R1-05 |
| OQ-SA3 | WebSocket session revalidation: every subscribe, revocation relay, 15 s sweep | R1-03 |
| OQ-SA4 | Whole-chain audit verification for auditors/risk/admin; own-scope for others; 10/min | R1-08 |
| OQ-SA5 | Anti-sybil: 10 sign-ups/IP/hour, 10 assessment attempts/IP/day | R1-11 |
| OQ-B3 | Margin call at 100 %, close-out at 50 % (PAPER) | R2-20 |
| OQ-T1 | Kill switch scope 2 keeps protective stops | R2-12 |
| OQ-T2 | Novice stop can only be tightened while the position is open | R2-04 |
| OQ-T3 | DAY on 24 h venues ends at the daily break / 17:00 New York | R2-19 |
| OQ-T4 | Charges converted then rounded once; base-currency change converts cash and limits | R2-05, R2-07 |
| OQ-T5 | Worst-case exposure of resting orders; fill-time re-check | R2-01, R2-03, R2-21 |
| OQ-R8a | Promotion evidence: gate-eligible run only, ≥ 90 holdout days, holdout DSR ≥ 0.95 | R3-02 |
| OQ-UX1 | Pro light theme keeps Pro typography and density | R5-13 |
| OQ-UX2 | View switch open to all, honest copy for novice-only accounts | R5-10 |
| OQ-UX3 | Ship the French assessment overlay pending Compliance review | R5-12 |
| OQ-UX4 | Ambiguous number input refused with a message, never guessed | R5-08 |

Re-verification took no new policy decision; the symmetric independence rule (section 5) is a correction within the
existing four-eyes policy (OQ-G4, ADR 0009 §4a).

Still **proposed**, awaiting Compliance/Security (not decided): OQ-G4 (role-grant policy: cooling period, first-admin
bootstrap, Keycloak mirroring), OQ-C3 (risk-warning acknowledgement scope and wording), OQ-C4 (assessment feedback
policy, R4-21).

## 7. Items that need the Sponsor or people (outside any delegate's authority)

| Item | Why | Reference |
|---|---|---|
| AI API key and billed model; live-provider evals (`pnpm evals:live`, CI `ai-evals-live`) | external contract; today only the scripted-provider regression runs | OQ-A2, B-703, R6-07 |
| Market-data and news licences (incl. AI-processing / translation rights) | contracts | OQ-M3, OQ-M4 |
| Legal sign-off per jurisdiction; regulatory figures (`[XX]%` retail-loss) | qualified counsel / regulator data | CHARTER §7, OQ-C1 |
| Licensed broker; `LIVE_TRADING_ENABLED` stays `false` | contract + compliance sign-off records | CHARTER §5, §7 |
| Compliance review of the (EN and FR) appropriateness questionnaire and risk-warning scope | qualified review | OQ-C1, OQ-UX3, OQ-C3, OQ-C4 |
| Human screen-reader sessions (NVDA, JAWS, VoiceOver, TalkBack) on the confirm step, kill switch and ticket announcements | people | R5-04, R5-05 |
| Real-device iOS/Android tests of the Novice PWA (tap-to-confirm, 320 px reflow) | people and devices | R5-04, R5-09 |
| External penetration test | people | CHARTER §7, S9 |
| Staging deployment, then the ZAP baseline (`release.yml`) and a first GitHub Actions run | environment | R6-14, `docs/security/scans.md` |
| Load-test exceptions E-1/E-2 | acceptance (PO may accept under §7) | OQ-O3 |

## 8. Final gate (re-verification, no retries)

Run on 2026-09-28 at `83e2550` (all re-verification fixes), on an otherwise idle host, with own databases
(`kora_irtc_rv_test`, `kora_irtc_rv_e2e`), e2e ports 4070/3070/8070/4170 and Redis prefixes `irtcrv:e2e:*`. Every
command ran exactly once (`rv/gate.sh`; Playwright `retries: 0`); logs in `rv/gate/`.

| Check | Result |
|---|---|
| `pnpm build --force` | pass (7/7 tasks) |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm format:check` | pass (whole repository) |
| `pnpm test` | pass (13/13 tasks): domain 222, api 261 (unit coverage 99.1 % lines), web 108, ui 126, market-data 72, sdk 16, bot-runner 12, ai-evals 4 |
| `pnpm test:integration`, run 1 | **50 files / 323 tests passed**; coverage 92.32 % lines / 82.93 % branches / 96.02 % functions, every floor met |
| `pnpm test:integration`, run 2 | **50 files / 323 tests passed**; 92.29 % / 82.76 % / 96.02 %, every floor met |
| `pnpm test:e2e`, run 1 | **92 passed**, 0 failed, 0 flaky (6.2 min); tick-to-paint p95 43.9 ms |
| `pnpm test:e2e`, run 2 | **92 passed**, 0 failed, 0 flaky (6.1 min); tick-to-paint p95 45.0 ms |
| `pnpm py:check` | pass: ruff, mypy --strict, **186 tests**, coverage 97.51 % |
| `pnpm evals` | **133/133**, RESULT PASS (scripted-provider regression; live evals pending OQ-A2) |
| `pnpm --filter @kora/web i18n:check` | pass (8 tests) |
| `pnpm contrast` | **152/152** pairs |
| Semgrep (`scripts/security/sast.sh`) | **0 findings**, 422 rules over 907 files |
| `pnpm audit --prod --audit-level high` | no known vulnerabilities |
| `pip-audit --skip-editable` (quant venv) | no known vulnerabilities |

Not re-run in this step (unchanged since the R6 gate): chaos drill (41/41), secrets-history scan (364/364 reviewed),
Storybook axe (84/84).

## 9. Committee sign-off

The committee signs off seat by seat against CHARTER §6 ("Critical and High fixed; Medium fixed or
owner-accepted; Low logged"):

| Seat | Critical / High | Medium | Low | Sign-off |
|---|---|---|---|---|
| R1 application security | 2/2 fixed (R1-02 completed in re-verification) | 4/4 fixed | 5/5 fixed | **Signed off** |
| R2 trading & money | 2 Critical + 3 High, 5/5 fixed | 10/10 fixed | 6 fixed, 4 logged with owners | **Signed off** |
| R3 quant & statistics | 5/5 fixed | 3/3 fixed | 6 fixed (1 superseded), 4 logged | **Signed off** |
| R4 AI safety & compliance | 2/2 fixed (R4-02 completed in re-verification) | 8/8 fixed (R4-04 completed in re-verification) | 10 fixed, 1 logged (policy, OQ-C4) | **Signed off** |
| R5 frontend, UX & a11y | 5/5 fixed | 11/11 fixed (R5-08 completed in re-verification) | 7 fixed, 3 logged | **Signed off**, conditional on the human screen-reader and real-device sessions (section 7) that no reviewer here could perform |
| R6 test integrity | 3/3 fixed | 4/4 fixed | 9/9 fixed | **Signed off** |

No Medium finding needed owner acceptance: every one is fixed. No finding was refuted. The 12 open Lows are in
`docs/BACKLOG.md` (B-1101 … B-1114; B-1115 … B-1120 are residuals and hardening, not findings). The committee's
sign-off covers the code review of RC-1 in PAPER mode only; it is not a market-launch opinion, which stays a Sponsor
gate (section 7, CHARTER §5).
