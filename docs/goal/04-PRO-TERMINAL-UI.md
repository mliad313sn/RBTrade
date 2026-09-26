# /goal 04 — Pro Terminal UI

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, `/design/prototype/Main.dc.html` (pixel reference, 1440×900).

## Goal
Implement the professional trading screen on top of goals 02–03. It should be dense, fast, keyboard-driven and faithful to the prototype.

## Scope
1. **Layout:**
   - 12-column grid: watchlist (2 cols), chart (7), order book + ticket (3), full-width blotter (240 px).
   - Dockable and resizable panels (e.g. `react-mosaic` or `dockview`), saved named layouts per user, and a reset-to-default option.
2. **Watchlist:**
   - multiple lists, add via ⌘K, drag to reorder;
   - last price, change % with ▲▼, spread;
   - flashes on change for 150 ms, stale badge, virtualised for 500 rows.
3. **Chart:**
   - `lightweight-charts` candles, timeframes 1m–1D, volume pane, EMA/SMA/VWAP/Bollinger/RSI/ATR (computed client-side from a shared, unit-tested indicator lib), and horizontal line / trendline drawing tools;
   - your own fills marked on the chart; working orders shown as draggable price lines (dragging amends the order after confirmation);
   - last price tag and crosshair with OHLC readout.
4. **Order book / depth:** 10–20 levels, cumulative size bars, spread and mid. Clicking a level fills the ticket price.
5. **Order ticket:**
   - Buy/Sell toggle and every order type from goal 03;
   - quantity in units, notional or % equity;
   - SL/TP in price, pips or %;
   - TIF, reduce-only, post-only;
   - live preview via `/orders/preview` (debounced 150 ms);
   - inline warnings (risk > the user's per-trade rule, event within 60 min);
   - confirmation dialog above user thresholds; hold-to-confirm (600 ms) for market orders above threshold.
6. **Blotter tabs:**
   - Positions (close, reverse, set SL/TP);
   - Orders (amend, cancel, cancel-all);
   - Fills (with slippage column);
   - Alerts (price and indicator alerts, server-evaluated);
   - Risk: net exposure by currency, VaR(95%, 1d, historical, from quant service when available), correlation clusters, daily loss vs limit.
7. **Top bar live data:** equity, day P&L, margin used %, daily-loss-limit meter. The kill switch is wired to goal 03, with a persistent halted banner and a resume flow with a reason.
8. **Hotkeys (configurable, shown in a cheat-sheet overlay):**
   - B/S focus the ticket side;
   - Ctrl+Enter submits;
   - Esc cancels the dialog;
   - Ctrl+Shift+K opens the kill switch;
   - Alt+1..5 switch panels;
   - ⌘K opens the palette.
9. **Settings:** colour convention (blue/orange default, green/red, red-up Asia), number density, UTC/local time toggle, sound on fills (off by default).
10. **AI strip placeholder** under the chart. Goal 07 fills it; leave a typed slot and a feature flag.

## Performance and quality bars
- Initial load < 2.5 s on a mid laptop (Lighthouse). Tick-to-paint < 100 ms. No layout shift when data streams in.
- The whole ticket-to-fill flow is keyboard-only operable. Screen-reader labels are present on every icon button.

## Acceptance criteria
- [ ] The Playwright e2e covers: search EUR/USD → set a limit buy with SL/TP → preview values match the API → confirm → it appears in Orders → drag the price line to amend → it fills in the simulated market → it shows in Positions and Fills with slippage → close the position.
- [ ] The kill-switch e2e holds for 1.5 s → scope 3 → the banner appears, orders are cancelled, positions are flat, and the audit entries are visible.
- [ ] Visual regression snapshots against the prototype at 1440×900 are within an agreed diff threshold, and the ≥ 1280 px breakpoint works.
- [ ] Indicator lib outputs match reference values (unit tests against known series).
- [ ] axe reports 0 serious violations, and the ≥ 4.5:1 text-contrast check passes.
- [ ] The STATUS update is done.
