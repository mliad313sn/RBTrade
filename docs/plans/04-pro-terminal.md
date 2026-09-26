# Plan 04 — Pro Terminal UI (+ B-009, B-011, B-208, B-210, B-305)

Lead seats: S6 (frontend engineer), S1 (principal product designer), S2 (senior trader). Reviewers at the gate: S8, S9, S10.
Reference: `design/prototype/Main.png` (1440×900). Depends on goals 02 (market data) and 03 (OMS, paper engine, risk, kill switch).

Built in parallel with goal 06 (robots), which owns `services/quant`, `services/bot-runner`, the robots route and migrations 0060+. This goal owns migrations 0040+ and runs its tests on its own databases and ports (§5.4).

## 1. Decisions up front

1. **Docking: `dockview-react`.** It has dockable, resizable groups, tabs, drag and drop, and JSON serialisation, with no dependencies. Its theme API takes a group gap and CSS variables, so the default layout can look like the prototype's separated panels. `react-mosaic` needs `react-dnd` and has no React 19 release. The default layout follows the spec grid: watchlist (2 of 12 columns) over the economic calendar, chart (7) with the AI strip under it, order book (with a Time & sales tab) over the ticket (3), and a full-width 240 px blotter.
2. **Named layouts are stored server-side per user.** Migration `0040_terminal.sql` adds `user_layouts` (user, name, dockview JSON ≤ 64 KB). The working layout is also autosaved to `localStorage`, so a reload keeps it. "Reset layout" rebuilds the default in code.
3. **Watchlists are server-side** (`watchlists`: user, name, position, symbols ≤ 500). A user starts with two lists: "Majors" (the prototype list) and "Global" (one instrument per registry venue, grouped by region). Symbols are added from ⌘K or the list's add button and reordered by drag (mouse) or Alt+↑/↓ (keyboard). Rows are virtualised with TanStack Virtual, tested with 500 rows.
4. **Hot path outside React.** One `MarketDataSocket` per page, with reference-counted subscriptions. Quotes land in an external store. Watchlist, order book and ticket cells update on `requestAnimationFrame` (flash 150 ms through a data attribute, no re-render of the list). Tick-to-paint is measured in the browser (WS frame received → frame painted) and asserted in e2e. Numeric cells use fixed widths and tabular figures, and panels reserve their height, so streaming data causes no layout shift. CLS is measured in e2e.
5. **Indicator library in `@kora/domain` (`indicators.ts`).** SMA, EMA, VWAP (session-anchored), Bollinger, RSI (Wilder), ATR (Wilder). It is pure, uses float64 and is unit-tested against published reference series. Indicators are display analytics, not money: the decimal rule applies to prices, quantities and P&L, and the chart converts registry decimal strings to numbers only for plotting. The api's alert evaluator uses the same library, so a server RSI alert and the chart agree.
6. **Chart: `lightweight-charts` v5.** Candles, volume on an overlay scale (as in the prototype), and RSI/ATR in separate panes. Timeframes 1m 5m 15m 1h 4h 1D come from `GET /candles` and the `candles:{symbol}:{tf}` channel. The crosshair shows an OHLC readout and the series shows its last-price tag. Drawing tools are a horizontal line (a price line) and a trendline (SVG overlay mapped with `timeToCoordinate`/`priceToCoordinate`), saved per symbol in `localStorage`. Own fills show as series markers. Working orders show as price lines with an HTML handle that you can drag or move with the arrow keys, so it is keyboard- and screen-reader-operable. Releasing a handle opens a confirmation, then `PATCH /orders/:id`.
7. **Ticket (B-305).** Buy/Sell, and every goal 03 type, including an OCO two-leg editor. Quantity in units, notional or % equity. SL/TP in price, pips (registry `pipSize`, falling back to the tick size) or %. TIF, reduce-only and post-only. A live preview through `POST /orders/preview`, debounced 150 ms. Inline warnings:
   - risk above the user's per-trade rule (a new preference, default 1 % of equity);
   - a calendar event in either instrument currency within 60 min;
   - session closed or data stale;
   - risk violations.

   A confirmation dialog opens when `preview.confirmation.required` is set. Market orders above the threshold need a 600 ms hold-to-confirm. A ticket prefill store (`useTicket().prefill(draft)`) is the entry point for the order book, the chart, the positions actions and goal 07 drafts (`source: 'ai-draft-accepted'`).
8. **Blotter.** Tabs:
   - Positions: close, reverse (with confirmation), set SL/TP as a reduce-only OCO; the stop and target columns come from the open protective orders.
   - Orders: amend inline, cancel, cancel-all through the new `DELETE /orders?symbol=`.
   - Fills: with a slippage column.
   - Alerts: price above/below and RSI above/below, evaluated by the server.
   - Risk: see decision 11.

   The blotter streams on the private channels `orders:`, `positions:` and `account:`, and falls back to REST polling when the socket is down.
9. **Alerts are server-evaluated.** `price_alerts` table in 0040. `AlertsService` runs in the api every `KORA_ALERTS_EVAL_MS` (default 1000). It reads last quotes from the goal 02 last-value cache and computes RSI from `/candles` data with the shared library. It triggers once, atomically (`UPDATE … WHERE status='active' RETURNING`), and audits `alert.created`, `alert.cancelled` and `alert.triggered`. The web polls and shows a toast.
10. **B-210.** The feed publishes `trades:{symbol}` as batches of prints (`{type:'trades', symbol, trades[]}`), one per flush. Batches, not single prints, so the 10/s conflation never drops prints. `parseChannel` accepts the channel. A Time & sales panel shows the prints.
11. **Risk tab: `GET /risk/summary`.**
    - Net exposure by currency, in local and base currency. FX pairs expose both legs; other instruments expose their quote currency.
    - VaR(95 %, 1 day, historical): position P&L is revalued on the last N ≤ 250 daily returns from `/candles` 1D. It needs at least 20 observations, otherwise it shows "not enough history (n/20)".
    - Correlation clusters: Pearson on daily returns, single-linkage at |ρ| ≥ 0.7.
    - Daily loss against the limit, from the account view.

    The maths is pure and unit-tested in `@kora/domain` (`risk-analytics.ts`). The quant service has no risk endpoint, and goal 06 owns `services/quant` right now, so the summary is computed in the api and labelled `source: 'api'`. Moving it to the quant service is B-401.
12. **B-208: session-aware badges.** The watchlist, the chart header and the ticket show the venue MIC and a session badge (Open, Pre, Post, Break, Closed, Holiday) from `session` in `/instruments`, refreshed each minute. "Market closed" is not "Stale": the Stale badge appears only when the session is open and the quote is stale.
13. **Settings (preferences, migration 0040 adds `terminal jsonb`).** Colour convention (existing), number density (compact/comfortable), time display (UTC/local), sound on fills (off by default, WebAudio beep), per-trade risk %, and configurable hotkeys. The cheat sheet (`?`) reads the same map.
14. **Hotkeys (configurable).** B/S focus the ticket side, Ctrl+Enter submits, Esc closes the dialog (Radix), Ctrl+Shift+K is the kill switch (existing), Alt+1..5 focus the watchlist, chart, order book, ticket and blotter, ⌘K/Ctrl+K opens the palette, `?` opens the cheat sheet. Single-key hotkeys are ignored while the focus is in a text field.
15. **⌘K palette (B-009).** Instruments from the whole registry, searched by symbol, name, ISIN, venue MIC or alias, grouped by region then asset class, each with its venue MIC and session badge. Actions: open an instrument, add it to the current watchlist, set an alert, go to a screen, save, load or reset the layout, switch the colour convention or density, show hotkeys, open the kill switch. It is a listbox combobox with arrow-key navigation.
16. **AI strip: typed slot plus a feature flag.** `KORA_AI_STRIP` = `off` | `placeholder` (default) | `on`. `AiStripSlot` props: `{symbol, timeframe, prefillTicket(draft: TicketDraft)}`. Goal 07 registers a component with `registerAiStrip()`. The placeholder only says that the copilot arrives in goal 07. It shows no invented numbers.
17. **Weekend determinism (acceptance e2e on EUR/USD).** FX is closed at weekends and the engine refuses fills then. The api gains `KORA_TRADING_SESSION_OVERRIDE` (a comma-separated list of symbols treated as `open` by the engine's market view). The config refuses it unless `KORA_ENV` is `dev` or `test`. The e2e api sets `EURUSD`, so the EUR/USD flow runs on any weekday. Everything else about fill safety stays in force.
18. **Global coverage.** Search and watchlists cover every registry venue and asset class. Prices are formatted with the registry precision and shown in the quote currency. P&L and margin are in the account base currency, with explicit currency codes. B-202 (GBX/ZAc minor units) needs registry columns and engine multiplier changes that goal 03 owns. It stays open (§6.3).

## 2. Files

- `packages/domain/src/indicators.ts` (+ test), `risk-analytics.ts` (+ test), `terminal.ts` (terminal settings, layout/watchlist/alert schemas, ticket maths: pips ↔ price, units ↔ notional ↔ % equity) (+ test). `market-data.ts`: `tradesChannel` + parse. `preferences.ts`: `terminal` settings, new hotkey ids.
- `apps/api/migrations/0040_terminal.sql`. `src/terminal/` (new module): `layouts.controller.ts`, `watchlists.controller.ts`, `alerts.controller.ts`, `alerts.service.ts`, `risk.controller.ts`, `terminal.repository.ts`. `market-data/feed.service.ts`: trades batches. `trading/orders.controller.ts`: `DELETE /orders` (cancel all). `trading/market-view.service.ts` + `trading-config.ts`: session override. `preferences.repository.ts`: `terminal` column.
- `packages/sdk`: client methods for the new endpoints, and typed socket helpers (`trades`, `orders`, `positions`, `account`).
- `apps/web/src/lib/terminal/`: market store, ticket store, hotkeys, formatters, layout default and persistence, AI strip registry. `apps/web/src/components/terminal/`: `Terminal.tsx` (dockview host) and panels (`Watchlist`, `Chart`, `OrderBook`, `TimeAndSales`, `Ticket`, `Blotter`, `Calendar`, `AiStrip`), plus `CommandPalette.tsx` and `HotkeyCheatSheet.tsx` (mounted in the Pro shell). Settings form additions.
- `apps/web/e2e/`: `terminal.spec.ts` (acceptance flow), `terminal-kill-switch.spec.ts`, `terminal-visual.spec.ts` (+ committed baseline), `terminal-a11y-perf.spec.ts`. `apps/web/e2e/fixtures/terminal.ts` (deterministic SIMULATED fixtures for the visual run).
- Docs: this plan, ADR 0004, STATUS, BACKLOG (B-401+), `.env.example`.

## 3. Schema (0040)

- `user_preferences.terminal jsonb NOT NULL DEFAULT '{}'`.
- `user_layouts (user_id, name ≤ 40, layout jsonb ≤ 64 KB, updated_at, PK (user_id, name))`, at most 20 per user (enforced in the api).
- `watchlists (id uuid, user_id, name ≤ 40, position int, symbols text[] ≤ 500, updated_at, UNIQUE (user_id, name))`.
- `price_alerts (id uuid, user_id, symbol, condition in (price_above, price_below, rsi_above, rsi_below), threshold numeric, timeframe, status in (active, triggered, cancelled), note, created_at, triggered_at, triggered_value numeric)`, with a partial index on active alerts.
- Grants to `kora_app`: SELECT, INSERT, UPDATE, DELETE on these tables; SELECT for `kora_audit_reader`.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Live SIMULATED data makes screenshots non-deterministic | The visual test mocks REST with fixtures (`page.route`) and replaces the WebSocket (`page.routeWebSocket`) with a silent one. It compares against our committed baseline (strict) and against `Main.png` (structural, §5.3). |
| FX closed at weekends (today is a Saturday) | Session override for EURUSD in the e2e api only (§1.17). BTC/USD for the other flows. |
| Parallel goal 06 on the same Postgres/Redis | Own DBs (`kora_test_g4`, `kora_e2e_g4`), ports (4024/3024/8024) and Redis prefix for runs in this session, set through env the configs already read. Defaults are unchanged for CI. |
| dockview CSS vs tokens | Theme class maps dockview variables to KORA tokens. axe and contrast checks run in e2e. |
| Canvas chart is not accessible | The chart has an `aria-label` with a summary, and the OHLC readout sits in an `aria-live="off"` region with a "Latest candle" text. Order handles are real buttons. The data is also in the blotter. |
| Bundle size vs a 2.5 s load | The terminal panels load with `next/dynamic` (chart and dockview client-only). Lighthouse on the production build (§5.2). |

## 5. Test plan (maps to acceptance criteria)

### 5.1 Acceptance e2e

1. `terminal.spec.ts` (**criterion 1**):
   - ⌘K search "EUR/USD" → Enter → the chart header shows EUR/USD.
   - Limit buy, limit price below the bid, SL/TP in pips.
   - Capture the `/orders/preview` response and check that the displayed notional, fees, margin, loss at stop and reward:risk equal the response values (formatted).
   - Review → confirm → the order is in Orders.
   - Drag the price-line handle above the ask → confirm the amendment → the order fills in the simulated market.
   - Positions shows EURUSD, and Fills shows a row with a slippage cell.
   - Close from Positions → flat.
2. `terminal-kill-switch.spec.ts` (**criterion 2**): an open position plus a working order on BTC/USD → a 1.5 s hold → scope 3 → halted banner → the Orders and Positions tabs are empty → `/audit` shows `kill_switch.requested`, `kill_switch.orders_cancelled` / `kill_switch.completed` rows for this switch.
3. `terminal-visual.spec.ts` (**criterion 3**): see §5.3. The ≥ 1280 px breakpoint check runs at 1280×800: no horizontal scroll, all six panels visible and at least 160 px wide.
4. Indicator unit tests (**criterion 4**): `packages/domain/src/indicators.test.ts` against published reference series (the StockCharts SMA/EMA, Bollinger, RSI and ATR worked examples, and a hand-computed VWAP).
5. `terminal-a11y-perf.spec.ts` (**criterion 5**): axe (wcag2a/aa, wcag21aa, wcag22aa) on the terminal with 0 serious or critical violations. A computed-contrast scan of every visible text node on the terminal requires ≥ 4.5:1 (≥ 3:1 for large text). It also measures tick-to-paint and CLS, and runs a keyboard-only ticket-to-fill (B, type, Ctrl+Enter, confirm with Enter).

### 5.2 Performance

- **Tick-to-paint:** the market store records `performance.now()` when a WS frame is dispatched, and again in the next `requestAnimationFrame` after the DOM write. The e2e reads `window.__koraPerf` and asserts p95 < 100 ms. Server-side feed-to-socket latency is covered by goal 02's load test.
- **CLS:** a `PerformanceObserver` records `layout-shift` entries after the first paint, for 5 s of streaming. Assert < 0.02.
- **Lighthouse:** run from a scratch npm install (not added to the repo lockfile) against `next start`, with Chromium from `/opt/pw-browsers`, desktop preset, an authenticated cookie, and `/terminal`. If Lighthouse cannot run here, we record Playwright navigation timing (FCP, LCP, load) instead.

### 5.3 Visual regression: agreed thresholds

- **Own baseline (regression):** `expect(page).toHaveScreenshot('terminal-1440.png', { maxDiffPixelRatio: 0.01 })` on the fixture-driven terminal at 1440×900, with animations disabled and the clock masked.
- **Prototype comparison (fidelity), in the same spec:**
  - (a) *Structural:* the DOM rectangles of the top bar, left rail, watchlist, chart, order book, ticket, blotter and status bar are compared with rectangles measured on `Main.png` (committed in `e2e/fixtures/prototype-regions.json`). **Threshold:** each edge within 24 px, and mean IoU ≥ 0.85.
  - (b) *Perceptual:* both images are downscaled to 180×112, converted to luminance and box-blurred, then compared by mean absolute difference. **Threshold:** mean abs diff ≤ 0.12 (0 to 1 scale). A side-by-side and diff image is written to `test-results/prototype-compare/` as an artefact.

  Differences we accept on purpose: dark ink on buy/sell fills (OQ-D2), no invented copilot numbers, and our own SIMULATED values.

### 5.4 Other tests

- Domain: terminal maths (pips/percent/notional conversions, per-trade risk warning), risk analytics (exposure, VaR, correlation, clusters).
- API integration (`terminal.int.test.ts`): layouts CRUD and limits, watchlists CRUD and symbol validation, alerts create/cancel/trigger with audit, cancel-all, the risk summary shape, the `trades:` channel over WS, and the session override refused outside dev/test (unit).
- Web unit: market store batching and tick-to-paint bookkeeping, watchlist virtualisation with 500 rows, ticket helpers, hotkey matcher, palette grouping.
- Runs in this session use `kora_test_g4` / `kora_e2e_g4`, ports 4024/3024/8024 and Redis prefix `kora:e2e-g4:md:` through `DATABASE_URL_*`, `E2E_*_PORT` and `E2E_MD_REDIS_PREFIX`. The defaults stay the same for CI.

## 6. Results (verified 2026-09-26 on the working branch)

The runs used this session's isolated resources (§5.4): `kora_test_g4` / `kora_e2e_g4`, ports 4024/3024/8024 and Redis prefix `kora:e2e-g4:md:`. Today is a Saturday, so FX sessions were closed during every run.

### 6.1 Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | e2e: search EUR/USD → limit buy with SL/TP → preview values match the API → confirm → Orders → drag the price line to amend → fills → Positions and Fills with slippage → close | **Pass** | `apps/web/e2e/terminal.spec.ts` › "search EUR/USD → …". See the detail below. |
| 2 | Kill-switch e2e: hold 1.5 s → scope 3 → banner, orders cancelled, positions flat, audit entries visible | **Pass** | `apps/web/e2e/terminal-kill-switch.spec.ts`. See the detail below. |
| 3 | Visual regression vs the prototype at 1440×900 within the agreed thresholds; ≥ 1280 px breakpoint | **Pass** | `apps/web/e2e/terminal-visual.spec.ts`: own baseline `terminal-1440-chromium-linux.png` (≤ 1 % pixels); mean IoU **0.973** (≥ 0.85), every edge ≤ 11 px (≤ 24); perceptual mean \|Δluma\| **0.0398** (≤ 0.12). The 1280×800 run has no horizontal scroll and every panel ≥ 160 px wide. |
| 4 | Indicator library matches reference values | **Pass** | `packages/domain/src/indicators.test.ts`, 10 tests. See the detail below. |
| 5 | axe 0 serious violations; text contrast ≥ 4.5:1 | **Pass** | `apps/web/e2e/terminal-a11y-perf.spec.ts`. See the detail below. |
| 6 | STATUS update | **Done** | `docs/STATUS.md`: G4 row and the goal 04 section |

**Criterion 1 in detail.** The acceptance flow runs these steps:
- The palette (Ctrl+K) searches "EUR/USD", and Enter switches the chart and the URL.
- Limit buy 100,000 at 10 pips under the bid, SL 20 pips, TP 40 pips. The request body carries SL = limit − 0.0020 and TP = limit + 0.0040 (registry pip size).
- The notional, fees + spread, margin, loss at stop (and % of equity) and reward:risk on screen equal the captured `/orders/preview` response.
- The confirmation dialog opens (notional > 50,000) → the order is working → the streamed Orders tab shows it.
- The order-line handle is dragged above the ask → the amend dialog shows the new price → PATCH 200 → fill.
- Positions shows a long 100,000 with its stop, and Fills has a row with a slippage cell.
- Close → flat, the protective orders are cancelled, and 3 fill rows remain.

EUR/USD is in session through `KORA_TRADING_SESSION_OVERRIDE=EURUSD`, which only the e2e api sets (ADR 0004 §11).

**Criterion 2 in detail.**
- Setup: a BTC/USD position and a resting limit.
- A 1.5 s mouse hold → scope 3 → "1 order cancelled. 1 position closed. Audit event #…".
- The halted banner appears. The tabs go to `Positions (0)` / `Orders (0)` and both tables empty.
- The banner persists after a reload.
- `/audit` shows `kill_switch.requested` and `kill_switch.completed`, and the API confirms `scope: robots_cancel_flatten`.

**Criterion 4 in detail.** The tests cover:
- the StockCharts 10-day SMA/EMA (30 closes, ±0.006 / ±0.011) and 14-period Wilder RSI (33 closes, ±0.02) worked examples;
- a hand-computed Bollinger band plus a check against the naive definition;
- a hand-computed Wilder ATR and true range;
- a hand-computed VWAP with a UTC-day reset.

The api's RSI alert uses the same library, covered by an integration test.

**Criterion 5 in detail.**
- axe (wcag2a/aa, 21a/aa, 22aa) reports 0 serious or critical violations on the live terminal, on each blotter tab, on time & sales, with the palette open and with the cheat sheet open.
- The computed contrast scan of every visible text node finds 0 failures.
- No button lacks an accessible name.
- The keyboard-only ticket-to-fill passes: B → Tab to Market → Space → quantity → Ctrl+Enter → Tab to the hold button → hold Space 750 ms → filled → Alt+5 focuses the blotter.

### 6.2 Performance

| Bar | Result |
|---|---|
| Tick-to-paint < 100 ms | p50 **28.8 ms**, p95 **42.0 ms**, max 43.8 ms (817 updates, 6 s of BTC/USD + watchlist streaming; e2e asserts p95 < 100) |
| No layout shift while streaming | CLS after first render **0.0000**; whole page load 0.0164 (e2e asserts < 0.01 streaming, < 0.1 total) |
| Initial load < 2.5 s (Lighthouse, production build) | Lighthouse 13.5.0, Chromium 141, `--preset=desktop`, authenticated `/terminal`: performance **0.95**, accessibility **1.00**, best practices 0.96; FCP 0.4 s, **LCP 1.4 s**, TTI 1.4 s, TBT 80 ms, CLS 0.008. With `--throttling.cpuSlowdownMultiplier=4` (a slower "mid laptop"): LCP **2.1 s**, TTI 2.2 s, TBT 730 ms, performance 0.64. Lighthouse ran from a scratch `npm i lighthouse` outside the repo (not in the lockfile); CI wiring is B-405. |
| Navigation timing in e2e | load event 223 ms, FCP 180 ms (asserted < 2,500 ms) |

### 6.3 Prototype comparison method (agreed thresholds)

- **Region measurement.** Panel borders were measured on `Main.png` with pngjs by scanning rows and columns for the border colour `#262E3B` against the `#0B0E13` background. The results are committed in `apps/web/e2e/fixtures/prototype-regions.json`:
  - top bar 0–41;
  - rail 0–48;
  - panels at x 55/287/1092, y 49, with 8 px gaps;
  - blotter 683–869;
  - status bar 877–900.

  The DOM rectangles of the dockview groups are compared edge by edge (≤ 24 px) and by IoU (mean ≥ 0.85).
- **Perceptual comparison.** Both 1440×900 images → 8× block-mean luminance → 3×3 box blur → mean absolute difference ≤ 0.12.
- **Artefacts.** The test writes `test-results/prototype-compare/prototype-vs-ours.png` (side by side), `prototype-vs-ours-luma.png` (prototype | ours | heat map) and `report.txt`.
- **Deliberate differences.**
  - Dark ink on the buy/sell fills (OQ-D2).
  - The copilot strip shows no invented numbers (goal 07).
  - Every panel has a dockview tab header; the prototype's chart has none.
  - The calendar is its own panel under the watchlist.
  - Our SIMULATED fixture values.

### 6.4 Gate run

| Command | Result |
|---|---|
| `pnpm build` | 7/7 tasks successful |
| `pnpm lint` | 12/12 successful, 0 errors |
| `pnpm typecheck` | 12/12 successful |
| `pnpm test` | domain 132, ui 113, market-data 60, api unit 38, sdk 13, web 29, bot-runner 5, all passing; domain coverage 99.9 % lines (indicators, terminal and risk analytics 100 %) |
| `pnpm test:integration` | 18 files, **125 tests** passed (7 new in `terminal.int.test.ts`: layouts, watchlists, alerts with audit and a once-only trigger, cancel-all, risk summary, terminal preferences, `trades:` channel) |
| `pnpm test:e2e` | **36 passed** (2.2 min), including 10 new goal 04 tests in 4 specs; goal 02/03 specs updated for the Pro ticket (hold to confirm) and the status bar |

### 6.5 Deferred (with reason)

- **B-202 (GBX/ZAc minor units).** Needs registry columns and changes to the engine's quantity multiplier, which goal 03 owns. It is not cheap to do safely now; retargeted to 09.
- **B-004 / B-312 (SDK generated from OpenAPI).** The OpenAPI document is regenerated (`packages/sdk/openapi.json`) and the hand-written SDK gained typed terminal methods. Generation needs response schemas on every endpoint; retargeted to 10.
- **B-506 (typed `/sim/*` SDK methods).** Not needed by the terminal; retargeted to 08.
- **VaR from the quant service** (spec: "when available"). The quant service has no risk endpoint, and goal 06 owns it during this goal. The api computes it with unit-tested domain code and labels the source (B-401).
- **Order book depth.** The simulator publishes 10 levels. The panel shows 10 per side (the spec allows 10–20). Aggregation / 20 levels is B-406.
- **Server-pushed alert notifications.** The web polls every 5 s (B-403).
