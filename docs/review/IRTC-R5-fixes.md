# IRTC R5 corrections: frontend, UX and accessibility

Corrector for the R5 review (seat R5, report dated 2026-09-27 on `claude/magical-newton-yyxga6` @ `b2bb0b6`).
Process per CHARTER §6: confirm or refute each finding, write a regression test that fails before the
fix, fix the root cause, show the test passing. Product and policy choices were taken by the Product Owner
under the delegated Sponsor authority (CHARTER §7) and are recorded in `docs/open-questions.md`
(OQ-UX1 … OQ-UX4), always taking the conservative option.

Evidence paths below are relative to the session scratchpad
`/tmp/claude-0/-home-user-RBTrade/528a68cd-e59a-54bf-af1d-f02a3ff25170/scratchpad/`:

- `irtc/r5/` is the reviewer's material (scripts, `shots/`, `logs/`);
- `r5e/before/` holds the Playwright failure artefacts (screenshot, trace, page snapshot) of the new
  regression tests run against the unfixed build;
- `r5e/after/` holds screenshots of the fixed build.

The regression tests are:

- `apps/web/e2e/irtc-r5.spec.ts`: one Playwright test per finding (22 tests);
- unit and component tests named per finding below.

## Summary

| ID | Sev. | Verdict | Fix commit | Regression test |
|---|---|---|---|---|
| R5-01 | High | Confirmed (worse than reported: an unconfirmed 0.5 BTC order was placed with no dialog) | `f1e7f55` | e2e `R5-01` |
| R5-02 | High | Confirmed | `de444d7` | e2e `R5-02`; `live-book.test.ts` |
| R5-03 | High | Confirmed | `a3c337a` | e2e `R5-03`; `robots.test.ts` |
| R5-04 | High | Confirmed | `5644f24` | `HoldToConfirm.a11y.test.tsx`; e2e `R5-04` |
| R5-05 | High | Confirmed | `f1e7f55` | e2e `R5-05`; `ticket-preview.test.ts` |
| R5-06 | Medium | Confirmed | `de444d7` | e2e `R5-06`; `live-book.test.ts` |
| R5-07 | Medium | Confirmed | `f1e7f55` | e2e `R5-01` (result line); `ticket-preview.test.ts` |
| R5-08 | Medium | Confirmed | `27739a9` | `NumberInput.locale.test.tsx`; e2e `R5-08` |
| R5-09 | Medium | Confirmed | `0d2f5ea` | e2e `R5-09` (Pro and FR novice) |
| R5-10 | Medium | Confirmed | `712f7ee` | e2e `R5-10` |
| R5-11 | Medium | Confirmed | `6a98424` | e2e `R5-11` |
| R5-12 | Medium | Confirmed | `712f7ee` | e2e `R5-12`; `i18n.test.ts` |
| R5-13 | Medium | Confirmed | `0d2f5ea` | e2e `R5-13` |
| R5-14 | Medium | Confirmed | `0d2f5ea` | e2e `R5-14`, `R5-14/R5-16` |
| R5-15 | Medium | Confirmed | `0d2f5ea` | e2e `R5-15` (Pro and novice); `tokens.test.ts`; `pnpm contrast` |
| R5-16 | Medium | Confirmed | `0d2f5ea` | e2e `R5-14/R5-16`; `tokens.test.ts` |
| R5-17 | Low | Confirmed, **not fixed**: CSP policy is R1's (see "Open") | — | — |
| R5-18 | Low | Confirmed | `4d15ba5` | e2e `R5-18`; `irtc-r5-lows.test.ts` |
| R5-19 | Low | Confirmed | `4d15ba5` | `irtc-r5-lows.test.ts` |
| R5-20 | Low | Confirmed | `52cf5d4` | `novice.spec.ts` (review sheet) |
| R5-21 | Low | Confirmed; fixed except the AI strip "Why?" toggle (R4's file) | `662c710` | e2e `R5-21` |
| R5-22 | Low | Confirmed | `662c710` | e2e `R5-22` |
| R5-23 | Low | Confirmed; tile overflow and P5 colour fixed, page height and fold left open | `662c710` | manual (see below) |
| R5-24 | Low | Confirmed | `662c710` | `PromotionChecklist.test.tsx` |
| R5-25 | Low | Confirmed | `712f7ee` | e2e `R5-25` |
| R5-26 | Low | Confirmed | `52cf5d4` | e2e `R5-26` |

## High

### R5-01 · The confirm dialog and hold-to-place used a stale preview

- **Verdict: confirmed, and worse than reported.** Against the unfixed build, the regression test
  (0.01 BTC previewed, the preview endpoint delayed 1.5 s, the quantity changed to 0.5 and Ctrl+Enter
  pressed at once) placed a **0.5 BTC market order with no confirmation dialog at all**. The old 0.01
  preview was below the confirmation threshold, so `review()` called `place()` with the new body.
  The result line read "Order filled: buy 0.5 BTCUSD at 64795.42884." (R5-07 too).
  Evidence: `r5e/before/batch1/irtc-r5-Pro-terminal-trade-cb339--changed-just-before-Review-chromium/`
  (`error-context.md`: position 0.5 BTC open, no dialog); the reviewer's `irtc/r5/shots/ticket_stale_preview_at_submit.png`.
- **Root cause:** `Ticket.tsx` kept one `preview` state with no record of which request it described.
  `canSubmit`, `review()` and the dialog read it; `place()` posted the live `body`.
- **Fix** (`Ticket.tsx`, `lib/terminal/ticket-preview.ts`):
  - every preview is stored with its **request key** (the exact JSON body) and **input key** (what the
    user typed and chose; market-relative stops change the body every tick but not this key);
  - Review freezes the current body. It reuses the preview on screen only if its request key equals the
    frozen body; otherwise it waits for the in-flight preview of that body or fetches one ("Checking…");
  - risk violations and `confirmation.required` are decided from that fresh preview;
  - the dialog holds a `BoundOrder` (`body` and its preview). The figures, the title and the hold or
    Place button all use it, and `place()` sends exactly `bound.body`;
  - any user edit (or an AI/draft prefill) while the dialog is open closes it;
  - figures computed for an older edit are marked "Updating the preview for your change…" (italic,
    dotted underline, `aria-busy`), never presented as current.
  - Server-side binding (an optional `previewHash` on POST /orders) would add defence in depth. It is
    R2's backend and is listed under "Open".
- **Test:** e2e `R5-01` asserts that the dialog title and figures equal a preview the server computed
  for 0.5 BTC, and never the 0.01 figures. It also asserts that the POST /orders body carries qty "0.5"
  and that the result line shows the price at 1 decimal. It fails on the unfixed build and passes now.

### R5-02 · Blotter Mark and Unrealized P&L frozen, three different P&L figures on one screen

- **Verdict: confirmed.** On the unfixed build, the Positions row showed a single Mark value across
  16 samples over 8 s (`marks.size = 1`). Evidence: `r5e/before/batch2/…R5-02…/`, reviewer `irtc/r5/shots/pnl_mismatch.png`.
- **Root cause:** `positions:` and `account:` are published by the engine only on trade events, and the
  REST reconcile runs every 20 s. The top bar polled its own copy every 5 s, and the blotter summary
  used a third copy (the WS account).
- **Fix** (`lib/terminal/live-book.ts`, `use-live-book.ts`, `trading.ts`, `lib/account.ts`):
  - the trading stream subscribes to the quotes of every open position (the same market store as the
    watchlist) and commits them at most 4 times a second;
  - positions are repriced with the engine's rules: bid for a long, ask for a short, and
    multiplier × FX recovered from the engine's own notional;
  - account equity is cash + Σ unrealized, and day P&L is equity − (engine equity − engine day P&L);
    margin and loss-limit use follow;
  - the blotter rows, the blotter summary and the top bar all read one hook, `useLiveBook`, over one
    shared account snapshot (the newest of the REST poll and the WS push, by `asOf`);
  - if the two engine snapshots describe different books (a trade in flight), the engine's figures are
    shown until they agree;
  - a position is flagged **Stale** when its quote is stale or older than 10 s, or when an unpriced
    snapshot is older than 10 s.
- **Tests:** `live-book.test.ts` (long/short marks, the FX multiplier on a JPY cross, stale rules,
  account consistency, fallback). e2e `R5-02`: the Mark changes over 8 s, and the summary's unrealized
  equals the row's P&L when both are read in the same frame.

### R5-03 · Status bar "Robots: none" hard-coded

- **Verdict: confirmed.** On the unfixed build the element had no source and showed "Robots: none"
  while two robots were RUNNING (reviewer `irtc/r5/shots/robot_running.png`; `r5e/before/batch2/…R5-03…/`).
- **Fix:** `StatusBar.tsx` loads GET /robots every 10 s for robot-builder roles and shows
  "Robots: N running · M paused" (`robotsStatusLabel`), links to /robots, and shows "Robots: —" when
  the list fails to load.
- **Tests:** `robots.test.ts` (label rules). e2e `R5-03`: none → 2 running → 1 running · 1 paused after
  a paper-run and a pause through the API.

### R5-04 · Hold-to-confirm unusable with screen readers, voice control and taps

- **Verdict: confirmed.** Before the fix, `element.click()` on the kill switch did nothing. Five of the
  six new unit tests failed (all except "the click that ends a hold does not double-confirm"). The e2e
  test (AT click opens the scope menu) failed. Evidence: `r5e/before/batch1/…kill-switch-scope-menu…/`.
- **Root cause:** `HoldToConfirmButton` started a hold only on `pointerdown` and on Space/Enter
  `keydown`, with no click path. Its strings were hard-coded English.
- **Fix** (`packages/ui/src/components/HoldToConfirmButton.tsx`):
  - a single activation opens an **explicit confirm step**. A single activation is a click with
    `detail === 0` (screen reader, voice control, switch access), a tap under 350 ms, or a short
    Enter/Space press. The confirm step is a built-in alert dialog with Cancel / Confirm, or the
    caller's `onActivate`;
  - the kill switch passes `onActivate` to open its scope menu directly, because choosing a scope is
    already an explicit confirmation. The hold stays as the fast path. A longer press released early is
    still an aborted hold: the existing "700 ms press does not open the menu" e2e test stands;
  - all strings are props (`labels`, `locale`, `confirmTitle`). The Novice view passes EN/FR copy
    (`hold.*` keys, `lib/i18n/hold.ts`), so French users hear "Maintenez 1,5 s…";
  - hold-to-place in the ticket, halt-all (robots) and the global kill switch (risk console) get a
    named confirm title.
- **Tests:** `HoldToConfirm.a11y.test.tsx` (AT click, tap, completed hold, short Enter, `onActivate`,
  French strings); e2e `R5-04`; the existing kill-switch e2e tests (mouse, Space, touch, hotkey holds)
  pass unchanged.

### R5-05 · Ticket preview live region floods screen readers

- **Verdict: confirmed.** On the unfixed build, 16 or more text changes occurred in the ticket's live
  regions in 8 s with a 200-pip stop (`r5e/before/batch1/…one-announcement-per-edit…/`; reviewer
  `irtc/r5/live.mjs`: 15 announcements in 10 s).
- **Fix:** `aria-live` is removed from the preview `<dl>`. A separate visually hidden `role=status`
  (`ticket-announce`) is fed by `SettledAnnouncer`. It announces one short summary ("Loss if stop hit …,
  margin …, fees ….") 1 s after a *user edit* settles, never again for the same edit, and never for
  tick-driven re-previews. `docs/qa/a11y.md` is updated.
- **Tests:** `ticket-preview.test.ts` (20 tick-driven offers give one announcement; new edits are
  debounced). e2e `R5-05`: at most 1 change in 8 s, and no `aria-live` on the preview.

## Medium

### R5-06 · Top-bar figures freeze silently when the account endpoint fails

- **Verdict: confirmed** (`r5e/before/batch2/…R5-06…/`: no stale marker after 20 s of 503s).
- **Fix:** the shared snapshot records `okAt` and `error`. The top bar shows "⚠ Stale figures, as of
  hh:mm:ss" (in a `role=status`) when the latest request failed or the last good snapshot is older than
  10 s (2× the poll), and clears it on recovery. The figures themselves come from `useLiveBook` (R5-02).
- **Test:** e2e `R5-06` (route /api/accounts/me to 503: the marker appears with a time; unroute: it
  disappears).

### R5-07 · Fill price with 40 decimals

- **Verdict: confirmed.** The unfixed build showed "at 64795.42884" for BTC (precision 1).
  A grep for raw decimal rendering found no other site: the blotter, time and sales, order book, chart
  and novice already use `formatPrice`.
- **Fix:** `orderResultText()` formats the average fill price at the instrument precision, for both the
  result line and the toast.
- **Tests:** `ticket-preview.test.ts`; the e2e `R5-01` result-line assertion.

### R5-08 · "2,500" read as 2.50

- **Verdict: confirmed** (`r5e/before/batch2/…R5-08…/`: "2,500" gave "500.00" after a fill; typed, it
  gave 2.50).
- **Root cause:** `NumberInput` replaced the first comma with a point in every language.
- **Fix:** `parseLocaleDecimal()` and a text-preserving controlled input:
  - English groups with commas and refuses a comma that is not between groups of three ("2,50") with a
    visible, announced message ("Use a comma only between thousands (2,500) and a point for decimals
    (2.5).") and no value;
  - French reads the decimal comma, and space, no-break-space, narrow no-break-space or dot grouping,
    and shows the value with a comma;
  - the language comes from the `locale` prop or the nearest `lang` attribute (the Novice view sets
    `<html lang="fr">`).
  - Product Owner decision OQ-UX4: refuse ambiguous input, never guess. One old unit assertion ("1,1"
    → 1.1 in English) encoded the defect and was changed.
- **Tests:** `NumberInput.locale.test.tsx`; e2e `R5-08` (EN "2,500" → 2500.00; "2,50" → message; FR
  "2 500,5" → "2500,50").

### R5-09 · Reflow at 320 px

- **Verdict: confirmed.** Before the fix, Pro /settings measured 460 px and FR /home 336 px
  (`r5e/before/batch2/…R5-09…/`).
- **Fix:**
  - the Pro top bar and status bar wrap (`flex-wrap`, `min-h` instead of a fixed height);
  - the novice balance headline uses `clamp(32px, 11vw, 44px)`;
  - novice buttons wrap (`white-space: normal`) and novice panels take `min-width: 0;
    overflow-wrap: anywhere`;
  - the terminal keeps its 2D-layout exception.
- **Test:** e2e `R5-09`, Pro (/settings, /audit, /portfolio) and FR novice (/home, /practice, /settings):
  `scrollWidth ≤ 320`.

### R5-10 · Novice-only users offered Pro; blank Pro pages under the novice shell

- **Verdict: confirmed** (`r5e/before/batch2/…R5-10…/`; the reviewer's `novice_click_pro.png`,
  `novpro_terminal.png`).
- **Fix** (Product Owner decision OQ-UX2). A first version sent novice-only users to the assessment
  instead of the Pro view. It broke the master goal's definition of done ("a new user can switch Pro ⇄
  Novice") and the goal 08 round-trip e2e test, so it was revised:
  - the switch stays open to everyone;
  - for an account without the trader role, the "View switched" note says the server keeps the
    simple-view rules (a stop loss on every new trade, no borrowing, no robots) and links to the
    assessment (`pro-safeguards`). It no longer promises "full order types, depth and robots";
  - `NoviceShell` renders `ProRouteNotice` for Pro routes opened in the simple view: an explanation, a
    switch button and, for novice-only accounts, the assessment link. It no longer renders the Pro panels
    into a zero-height layout that screen readers still read;
  - the assessment page shows why the check is needed when reached from Pro (`?from=pro`).
- **Test:** e2e `R5-10`.

### R5-11 · Portfolio placeholder

- **Verdict: confirmed.**
- **Fix:** a real `/portfolio`, built from GET /accounts/me, /positions and /fills with a 5 s refresh
  and a banner when a refresh fails. It shows:
  - equity, cash and unrealized P&L;
  - P&L today, this week and this month;
  - margin used and gross exposure;
  - the open positions and the last 50 fills.
  - The unused `Placeholder` component is removed.
- **Test:** e2e `R5-11`.

### R5-12 · English on FR novice screens; small radio targets

- **Verdict: confirmed** (`r5e/before/batch2/…R5-12…/`: title "Home · KORA").
- **Fix:**
  - `Appropriateness.tsx` is fully localised. The questions come from the graded data in English, and
    `appr.q.*` holds the French overlay. Its wording is pending Compliance review (OQ-C1 / OQ-UX3); the
    existing "SIMULATED questions · pending Compliance review" chip stays;
  - every answer is a full-width 44 px row;
  - Novice page titles use `generateMetadata` (`lib/i18n/metadata.ts`). Screens shared with Pro are
    French only in the simple view;
  - the verbatim questionnaire keys are excluded from the Novice readability corpus, because Compliance
    owns that wording;
  - the Portfolio placeholder no longer exists (R5-11), the HoldToConfirm strings are localised (R5-04),
    and "View switched" was already localised for the simple view.
- **Tests:** `i18n.test.ts` (EN equals the graded data, FR is translated, key parity); e2e `R5-12`.

### R5-13 · Pro views break in the light theme

- **Verdict: confirmed** (`r5e/before/batch2/…R5-13…/`: 44 px kill switch, Figtree numbers).
- **Fix** (Product Owner decision OQ-UX1): the Novice sizing and faces apply only outside the Pro mode.
  Selectors are `[data-theme='novice-light']:not(:where([data-mode='pro']))`, with zero added
  specificity, and `data-mode` is also set on `<html>` for portalled dialogs. The light palette in Pro
  gets the Pro faces (tabular IBM Plex Mono numbers) and 28 px controls.
- **Test:** e2e `R5-13`.

### R5-14 · No visible focus on `<summary>`; no disclosure marker on novice details

- **Verdict: confirmed** (`r5e/before/batch2/…R5-14…/`).
- **Fix:**
  - the global focus-visible rule now covers `summary`, `textarea`, `[role=button|tab|option]`;
  - novice disclosures ("Why this level", "How we worked this out") show a ▸ marker that rotates open
    (no motion under reduced-motion).
- **Tests:** e2e `R5-14` (2 px focus-token ring); `R5-14/R5-16` (marker).

### R5-15 · Colour convention only partly applied

- **Verdict: confirmed** (`r5e/before/batch2/…R5-15…/`: `--k-up-surface` unchanged across conventions).
- **Fix** (`packages/ui/src/tokens.ts`, `build-css.ts`, `contrast.ts`):
  - conventions now define `upSurface`/`downSurface`, used by the depth bars, the tick flash and the
    chosen buy/sell option;
  - new meaning tokens independent of direction:
    - `accent-surface` for selection highlights (nav, chosen option, balance chart area);
    - `loss` for "Most you could lose";
    - `risk` for the risk bars;
    - `ok` for the connection dot;
  - the contrast script now also checks direction text on its convention surface (4.5:1) and meaning
    graphics (3:1): 152/152 pass.
- **Tests:** `tokens.test.ts`; e2e `R5-15` (Pro surfaces change and the connection dot does not;
  novice risk colour identical across conventions and never green).

### R5-16 · Risk bars fail non-text contrast; level not in text on the home card

- **Verdict: confirmed** (`r5e/before/batch2/…R5-14-R5-16…/`: empty segment #E2DDD2 on #FFFFFF ≈ 1.3:1).
- **Fix:** empty segments get a `border-strong` outline (#857F73, 3.9:1 on white; #667085 on pro-dark),
  and the home Auto-invest card prints "Risk level n of 5" next to the bars.
- **Tests:** e2e `R5-14/R5-16` (contrast ≥ 3 computed in the test); `tokens.test.ts` (`nonTextPairs`).

## Low

- **R5-17 (not fixed, open for R1):** the SSR `<link rel=preload as=script>` for the `next/dynamic`
  ProShell chunks carries no nonce under `'strict-dynamic'`, so Chromium refuses the preload (console
  noise only; the chunks still load). Options for R1: a nonce on preloads (Next passes the `x-nonce`
  header to its own scripts but not to these preloads in 15.5), or dropping the preload for that chunk.
  This is a CSP change in `middleware.ts` and belongs to the security corrector.
- **R5-18:** the chart gets `localization.locale = safeLocale(navigator.language)`, so an invalid tag
  falls back to en-US. e2e `R5-18` forces `navigator.language = "en-US@posix"`: it failed with
  "Invalid language tag" page errors before the fix and passes now. Unit: `irtc-r5-lows.test.ts`.
- **R5-19:** `displayDirection()` takes the direction from the value as displayed (the same rounding as
  `formatDecimal`). It is used by the watchlist change, novice holdings P&L and robot P&L. The robot
  `fmtNum`/`fmtSigned` no longer print "−0.0". Unit: `irtc-r5-lows.test.ts`.
- **R5-20:** the review sheet explains rounding ("We rounded $5,000.00 to $4,942.70, the closest amount
  this market allows."). The tick box reads "about X, or more if prices jump", matching the gap line
  above it (EN/FR). `novice.spec.ts` updated.
- **R5-21:** the following are now at least 24 px tall: order types, timeframes, chart menu summaries,
  watchlist tools and select, indicator rows, and the Reduce-only / Post-only rows. e2e `R5-21` failed
  before the fix with 90 elements under 24 px. The AI strip "Why?" toggle lives in
  `components/ai/CopilotStrip.tsx` (R4's area) and is left to R4.
- **R5-22:** the Market Radar empty state is one sentence with the next scan time ("next around hh:mm
  UTC"), replacing the dangling "Biggest movers:" / "Movers:". The page refreshes every minute so the
  sentence is true. e2e `R5-22`.
- **R5-23:** the P5 · P95 tile wraps inside its box, and each value is coloured, with ▲/▼, against the
  starting capital, so a P5 gain is no longer orange. **Open:** the 69 px page overflow at 1440×900 and
  "Run projection" below the fold need a simulator layout change (owner S6 / frontend, backlog).
- **R5-24:** the promotion checklist is a list with ✓/✗ glyphs and text instead of read-only
  checkboxes, and Promote is disabled until complete. `PromotionChecklist.test.tsx` failed before the fix
  (2 checkboxes found) and passes now.
- **R5-25:** `/risk`, `/internal-audit` and `/admin` always use the Pro shell (`isGovernanceRoute`). The
  e2e `R5-25` was written after the fix and **verified against a build with the fix reverted** (it failed:
  no Pro top bar), then passed with the fix. Evidence: `r5e/before/batch3-lows/…R5-25…/`.
- **R5-26:** the practice-money chip stays on phones in a short form ("Practice" / "Entraînement"). The
  light palette applies to `<html>` from the server render (`:root:has(.k-root[data-theme=novice-light])`
  in the generated tokens), so a novice page no longer paints dark before hydration. e2e `R5-26`
  (JavaScript disabled, 390 px).

## Visual-regression baseline

See "Gate" for whether `terminal-visual.spec.ts` needed a new baseline. The intended visual changes on the
terminal are the 24 px toolbar and ticket targets (R5-21) and the status-bar robots label (R5-03).

## Gate

Filled in at the end of the correction (see below).

## Open

| Item | Owner | Why not here |
|---|---|---|
| R5-17 CSP preload nonce | R1 (security) | CSP policy in `middleware.ts` |
| Server-side preview binding (`previewHash` on POST /orders) | R2 (trading backend) | Backend contract; the UI binding is done |
| AI strip "Why?" target size (R5-21) | R4 (AI) | `components/ai/CopilotStrip.tsx` |
| Simulator page height and "Run projection" fold (R5-23) | S6 frontend (backlog) | Layout redesign |
| French appropriateness wording | Compliance (OQ-UX3 / OQ-C1) | Needs qualified review |
| Human screen-reader session on the new confirm step and announcements | Sponsor (human review, CHARTER §7) | Needs people |
