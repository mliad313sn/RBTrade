# /goal 06 — Robot Trader: strategy builder, backtester, walk-forward and bot runner

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, `/design/prototype/Robots.dc.html`.

## Goal
Let users build rule-based trading robots without code, test them honestly (in-sample, out-of-sample and walk-forward, with overfitting checks), paper-run them through the same OMS as humans (goal 03), and promote them to live only through a governed checklist.

## Scope
1. **Strategy DSL (JSON schema, versioned):**
   - blocks for ENTRY / EXIT / SIZE / FILTERS;
   - conditions: indicator comparisons and crosses, thresholds, time/session filters, "no high-impact event within N min", AI regime filter (from goal 07, optional);
   - exits: ATR or % stop, target, trailing after xR, time stop;
   - sizing: % equity risk, fixed, volatility-targeted; max open positions.

   Each saved version is immutable and gets a content hash (e.g. `#a41f9c`). Parameter changes create a new version with an author and a reason, which is audit-logged.
2. **Visual builder UI:**
   - drag-and-drop blocks mirroring the prototype chips, with inline parameter editing;
   - a validation panel;
   - a "view as JSON" tab for quants and an import/export option.
   - Novice users cannot open the builder. They see **templates only** (goal 08).
3. **Backtester (`services/quant`):**
   - event-driven, bar-based with an intrabar stop/target resolution policy that is documented and conservative;
   - uses the same fee and slippage model as the paper engine (shared config);
   - point-in-time data only, with no look-ahead (a guard test injects future data and must fail);
   - splits: in-sample / out-of-sample by date, plus anchored or rolling walk-forward.
4. **Metrics (per split and live):** CAGR, Sharpe, Sortino, Calmar, max DD and its duration, win rate, profit factor, expectancy (in R and currency), trade count, exposure %, turnover, cost drag.
5. **Overfitting controls:**
   - count of parameter combinations tried (tracked automatically);
   - deflated Sharpe ratio (Bailey & López de Prado);
   - a parameter sensitivity heatmap over 2 chosen params;
   - a warning when OOS trades < 100 or when OOS Sharpe < 50% of IS.
6. **Optimisation:** grid or random search with a hard cap, and results ranked by OOS rather than IS.
7. **Bot runner (`services/bot-runner`, BullMQ):**
   - subscribes to market data, evaluates the strategy on bar close, and sends orders via the OMS with `source=robot:{id}`;
   - per-bot risk limits (daily/weekly loss, max DD auto-pause, orders/min, gross exposure);
   - heartbeat every 5 s; missing 3 beats pauses the bot and alerts;
   - live-vs-backtest tracking error computed daily;
   - reacts to the global kill switch within 1 s.
8. **Monitoring UI:**
   - robot list with run/pause, status and P&L;
   - KPI table (IS / OOS / WF / Live);
   - equity curve with the IS/OOS divider and a drawdown area;
   - risk-limit meters;
   - live audit feed;
   - a hold-to-halt-all button.
9. **Promote-to-LIVE workflow.** A checklist that must be satisfied with evidence:
   - OOS Sharpe ≥ a threshold;
   - ≥ 100 OOS trades;
   - ≥ 30 days of paper trading with tracking error < 1%;
   - risk limits signed by the `risk_officer` role (four-eyes).

   Then a 2FA confirmation. Promotion stays blocked while `LIVE_TRADING_ENABLED=false`, but the workflow and its records work.
10. "Send to Monte Carlo" posts the OOS trade list to goal 05's `/mc/from-trades`.

## Acceptance criteria
- [ ] The look-ahead guard test fails as intended when future data is injected. Backtests of a known toy strategy on a fixed synthetic series match hand-computed trades exactly.
- [ ] Paper-run fills for the same bars match the backtest trade list within the slippage-model tolerance (parity test).
- [ ] The deflated Sharpe implementation matches reference values from the paper.
- [ ] A bot auto-pauses when its max-DD limit is breached in a simulated crash, and it halts within 1 s of the global kill switch (integration tests).
- [ ] Promotion is impossible without every checklist item and a different user's risk sign-off (RBAC test).
- [ ] The e2e flow builds Trend-X from blocks → backtests → views the heatmap → runs walk-forward → sends to MC → paper-runs → pauses → edits params (new version hash) → sees the audit trail.
- [ ] The STATUS update is done.
