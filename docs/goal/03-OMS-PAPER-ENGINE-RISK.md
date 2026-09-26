# /goal 03 — Order management, paper trading engine, pre-trade risk and kill switch

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, `Main.dc.html` (order ticket, blotter, confirm dialog, kill-switch menu).

## Goal
Build the trading core: an order management system (OMS) with a realistic **paper execution engine**, positions and P&L, margin, pre-trade risk checks, reconciliation and a working three-scope kill switch. Manual traders and robots use exactly the same path.

## Scope
1. **Domain (`packages/domain`, decimals everywhere):**
   - `Order` with `client_order_id` (idempotency key), side, qty, type (market, limit, stop, stop-limit, trailing-stop, bracket, OCO), TIF (DAY/GTC/IOC/FOK/GTD), limit/stop prices, attached SL/TP, reduce-only, post-only, source (manual|robot:{id}|ai-draft-accepted), account.
   - Also: `Fill`, `Position` (net, avg price), `Account` (cash, equity, margin used/free, leverage), `LedgerEntry` (double-entry).
2. **Order state machine:** new → accepted → working → partially_filled → filled | cancelled | rejected | expired. Transitions are exhaustive and unit-tested, and each transition emits an audit event.
3. **Paper engine:**
   - Matches against the simulated or live quote plus the depth ladder.
   - Slippage model: spread + a size-vs-depth impact + a volatility term. It is configurable per asset class.
   - Partial fills for size above top-of-book depth.
   - Stops trigger on bid/ask correctly. A gap through the stop fills at the next available price and records realised slippage.
   - Fees: commission, spread cost, overnight swap/funding at the daily roll.
   - Every fill stores `quote_at_decision`, `fill_price` and `slippage`.
4. **Pre-trade risk service** (sync, target < 5 ms). It checks:
   - max order notional;
   - fat-finger band (% from mid, per asset class);
   - max position size;
   - max gross exposure / leverage;
   - daily and weekly loss limits;
   - orders per minute;
   - instrument trading-session status;
   - novice constraints (no leverage, stop required, market orders only with a protective stop).

   Every rejection has a machine code and a plain-language message.
5. **Order preview endpoint** `POST /orders/preview`: notional, estimated fees and spread cost, margin impact, loss if the stop is hit (in currency and % of equity), reward:risk, and whether confirmation is required (per user-set thresholds). The terminal and the novice flows both use it.
6. **Kill switch backend** `POST /kill-switch {scope: robots|robots_cancel|robots_cancel_flatten, reason}`:
   - idempotent, audit-logged, sets a `trading_halted` state that blocks new robot orders;
   - resume needs `POST /kill-switch/resume {reason}` by an authorised role;
   - reachable over REST even if the WS is down.
7. **Reconciliation job:** every 60 s and on demand. It compares engine positions with broker positions (paper: an internal ledger replay) and raises a critical alert on mismatch.
8. **Real-time:** WS channels `orders:{account}`, `positions:{account}`, `account:{account}`.
9. **LIVE path:** a `BrokerExecutionAdapter` interface plus one stub, behind `LIVE_TRADING_ENABLED` and a compliance sign-off record. It is not enabled.

## Acceptance criteria
- [ ] The same `client_order_id` sent twice creates exactly one order (concurrency test with 50 parallel requests).
- [ ] Property tests (fast-check / hypothesis):
  - the ledger always balances;
  - position qty equals the sum of signed fills;
  - realised + unrealised P&L reconciles to the equity change net of fees.
- [ ] A stop gapped by a simulated shock fills worse than the stop and reports slippage. Bracket and OCO cancel their siblings correctly.
- [ ] Each risk rule has a positive test, a negative test and a clear message. Novice orders without a stop are rejected.
- [ ] Kill switch scope 3 halts robots, cancels all working orders and flattens all positions within 2 s under a load of 1,000 open orders. The audit log shows each child action.
- [ ] The preview numbers match a hand-computed fixture for EUR/USD, XAU/USD, BTC/USD and one equity.
- [ ] OpenAPI is published, `docs/adr/0003-oms.md` is written, and the STATUS update is done.
