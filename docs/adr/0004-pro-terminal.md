# ADR 0004 — Pro terminal: docking, hot path, indicators, ticket, alerts, risk tab, test aids

- Status: Accepted (2026-09-26)
- Deciders: S6 (frontend engineer, lead), S1 (principal product designer), S2 (senior trader), S3, S8, S9, S10, Project Owner
- Context: goal 04, the prototype artboard `design/prototype/Main.png` (1440×900), goals 02 and 03 contracts, and the backlog items B-009, B-011, B-208, B-210 and B-305. Built in parallel with goal 06.

## Decision

### 1. Docking and layouts

- **Library: `dockview-react`** (v8, no runtime dependencies). It gives dockable and resizable groups, tabs, drag and drop, floating groups and a JSON model. `react-mosaic` was rejected because it needs `react-dnd` and has no React 19 release.
- **Theme.** A `dockview-theme-kora` class maps dockview's CSS variables onto the KORA tokens. The theme's 8 px `gap` and 30 px tab strip reproduce the prototype's separated panels. Measured against the prototype, the panels have a mean IoU of 0.973, and every edge is within 11 px.
- **Default layout.** Built in code (`buildDefaultLayout`) from the spec grid: watchlist (2 of 12 columns) over the calendar, chart (7), order book | time & sales over the ticket (3), and a full-width blotter whose tabs are dockview panels (Positions, Orders, Fills, Alerts, Risk).
  - The blotter is 186 px at 900 px high, as in the prototype, and 240 px from 1,000 px high (the spec value).
  - Each blotter tab can be dragged out into its own panel.
- **Closing and persistence.**
  - Panels cannot be closed. A layout must place every panel exactly once (`isCompleteLayout`), so "Reset to default" always works.
  - The working layout is autosaved to `localStorage`, but only when complete. A partial save during unmount once produced empty groups; this rule prevents it.
  - Named layouts are saved per user in `user_layouts` (migration 0040: ≤ 20 per user, ≤ 64 KB each). They are not audited, because they are UI state, not a trading action.

### 2. Hot path outside React

- **One `MarketStore` per mounted terminal.** It wraps one `MarketDataSocket`.
  - Quote, depth and trade subscriptions are reference-counted.
  - Updates are queued and delivered once per animation frame: the latest value wins for quotes and depth, and prints accumulate.
- **Watchlist rows write to the DOM directly**, through refs and a `data-flash` attribute for 150 ms. A tick never re-renders the list. The list is virtualised with TanStack Virtual (`VirtualRows`, tested with 500 rows), and only on-screen rows subscribe. This also keeps a large list under the gateway's per-connection channel cap.
- **Tick-to-paint** is recorded for every delivered update: WS frame received → start of the frame after the DOM write, that is, after paint. It is exposed as `window.__koraPerf` and in the status bar.
  - Measured: p50 28.8 ms, p95 42.0 ms, max 43.8 ms over 817 updates in e2e.
  - Server feed-to-socket latency stays covered by goal 02's load test.
- **No layout shift while data streams** (streaming CLS 0.0000). Four rules make this hold:
  - numeric cells use tabular figures and reserved widths;
  - the order book renders a fixed 10 slots per side, keyed by slot, so rows never move;
  - depth bars use `transform: scaleX`, not `width`;
  - status-bar fields have minimum widths.

### 3. Indicators

- **Library.** `@kora/domain/indicators.ts` provides SMA, EMA (SMA-seeded), Bollinger (population standard deviation), RSI and ATR (Wilder), and a session-anchored VWAP (`vwapSeries`, UTC day by default). It is tested against the StockCharts worked examples and hand-computed series.
- **Floats, by design.** Indicators are float64 display analytics. The decimal rule still covers prices, quantities and money: the chart converts registry decimal strings to numbers only for plotting.
- **Shared with the api.** The api's alert evaluator uses the same library, so a server RSI alert and the chart agree.

### 4. Chart interaction

- **Working orders.** Each is shown as a series price line with an HTML handle (a real `<button>`). The handle is dragged with the pointer or moved with ↑/↓ (Shift = 10 ticks). Releasing it or pressing Enter opens a confirmation, then `PATCH /orders/:id`.
  - Working-order prices are folded into the price scale's autoscale range, so a resting order stays on screen.
  - Trailing stops are drawn but cannot be dragged.
- **Drawings.** Horizontal lines are price lines. Trendlines are an SVG overlay mapped with `timeToCoordinate`/`priceToCoordinate`. Both are saved per symbol in `localStorage`.
- **Fills** appear as series markers (▲ B / ▼ S).

### 5. Ticket (B-305)

- **Inputs.** Every goal 03 order type, including an OCO two-leg editor and bracket entry market/limit.
  - Quantity in units, notional (account currency) or % of equity. Rounded down onto the registry `qtyStep`.
  - SL/TP in price, pips (registry `pipSize`, falling back to the tick size) or %. The resolved price is shown under the field.
  - Trailing distance in pips or price.
  - The maths is in `@kora/domain/terminal.ts`, in Decimal, and unit-tested.
- **Server preview.** `POST /orders/preview`, debounced 150 ms, with stale responses discarded.
- **Inline warnings.** Risk above the user's per-trade rule (a new `terminal.perTradeRiskPct` preference, default 1 %), no stop, a calendar event in either currency within 60 min, session not open, data not ok, and the server's risk violations.
- **Confirmation.** A dialog opens when `preview.confirmation.required` is set. Market-like orders then need a 600 ms `HoldToConfirmButton`, which works by mouse, touch and keyboard hold.
- **Prefill.** One entry point, `useTerminal().prefillTicket(draft)` or `terminalApi.prefillTicket`. It is used by the order book, the blotter actions and goal 07. `origin: 'ai'` makes the confirmed order go out with `source: 'ai-draft-accepted'`, and nothing can submit without the user's review.

### 6. Blotter and streaming

- **Private channels.** Positions, orders and account stream on `orders:`, `positions:` and `account:` (goal 03). REST reloads on start, after actions, every 5 s while the socket is not open, and every 20 s to reconcile.
- **Positions actions.** Set SL/TP replaces the position's protective orders with a reduce-only stop, target or OCO pair. Reverse sends a market order for 2× the position, after a confirmation.
- **Cancel all.** The new `DELETE /orders?symbol=` runs each cancel through the engine's normal path, so OCO, brackets and the audit trail behave as for a single cancel.

### 7. Alerts and the risk tab

- **Alerts.** `price_alerts` (migration 0040). An `AlertsService` runs in the api (`KORA_ALERTS_EVAL_MS`).
  - Price conditions use the mid of the last-value quote, and a stale quote never triggers.
  - RSI(14) conditions use the shared indicator library on `/candles`.
  - An alert triggers once (`UPDATE … WHERE status='active' RETURNING`). Create, cancel and trigger are audited; the trigger is audited under the system actor `alerts-evaluator`.
- **Risk tab: `GET /risk/summary`.**
  - Net exposure by currency (FX pairs expose both legs).
  - One-day historical VaR(95 %), from full revaluation on up to 250 aligned daily returns, with at least 20 required. The quantile is type 7.
  - Correlation clusters: single linkage at |ρ| ≥ 0.7.
  - Daily loss against the limit.

  The quant service has no risk endpoint, and goal 06 owns `services/quant` during this goal. So the api computes the summary with `@kora/domain/risk-analytics.ts` and labels it `source: 'api'` (B-401).

### 8. Session-aware UX (B-208) and global coverage

- **Badges.** Badges and the watchlist show the venue MIC and the session state from the registry, refreshed every minute. "Closed" is shown instead of "Stale" when the market is not open (`quoteBadge`).
- **Palette.** The ⌘K palette searches every instrument by symbol, display name, ISIN, venue MIC or vendor symbol. Results are grouped by region, then asset class.
- **Watchlists.** New users get "Majors" (the prototype list) and "Global" (one active instrument per registry venue, ordered by region).

### 9. Time and sales (B-210)

The feed publishes `trades:{symbol}` as batches of prints, one per 250 ms flush and at most 50. A batch is one message, so the gateway's 10/s latest-value conflation never drops a print.

### 10. AI strip slot

`KORA_AI_STRIP` = `off` | `placeholder` (default) | `on`.

- The slot's props are `AiStripSlotProps {symbol, timeframe, prefillTicket(draft)}`. Goal 07 calls `registerAiStrip(Component)`.
- The placeholder shows no numbers.

### 11. Test aids (refused in production)

- **`KORA_TRADING_SESSION_OVERRIDE`.** A comma-separated list of symbols that the engine's market view treats as `open`.
  - Why: FX is closed at weekends and the engine refuses fills then. The acceptance e2e trades EUR/USD, and this makes it deterministic on any weekday.
  - The config throws unless `KORA_ENV` is `dev` or `test`, and a unit test covers this.
  - Only the Playwright api sets it, to `EURUSD`. Every other fill-safety rule (a fresh quote, feed up) still applies.
- **Visual regression.** The run uses REST fixtures (`page.route`) and a mocked WebSocket (`page.routeWebSocket`) with a fixed clock, so screenshots do not depend on the simulator or the weekday. The baseline is our own render (`maxDiffPixelRatio` 1 %).
- **Fidelity to `Main.png`.** Checked separately:
  - structurally: every panel edge within 24 px, and mean IoU ≥ 0.85;
  - perceptually: 8× downscaled, blurred luminance, mean |Δ| ≤ 0.12.

  The side-by-side and diff images go to `test-results/prototype-compare/`.

## Consequences

- Goal 07 fills the AI strip through `registerAiStrip` and drafts orders with `prefillTicket`. The draft's `origin: 'ai'` becomes `source: 'ai-draft-accepted'` only when a human confirms.
- Goal 08 can reuse `@kora/domain/terminal.ts` (sizing, stop distances, warnings, session badges), the indicator library and the SDK methods. The Novice view does not use the dock.
- The visual baseline is platform-specific (Chromium, Linux fonts). CI must render in the same image or regenerate the baseline once (`--update-snapshots`), which is B-404.
- Lighthouse runs from a scratch install, not the repo lockfile. Wiring it into CI is B-405.
