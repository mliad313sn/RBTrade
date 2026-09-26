"""Event-driven bar backtester (portfolio across the strategy's instruments).

Timing and fill policy (conservative, documented in docs/quant/backtester.md):

1. The strategy decides on the close of bar t using bars 0..t only (`decide`, shared with the live
   bot through `/bt/signal`).
2. Entries and signal exits fill at the open of bar t+1: taker price = the touch (mid ± half
   spread on
   the tick grid) plus the volatility term `ceil_tick(volFactor × |open(t+1) − close(t)|)`.
3. Protective stops and targets rest from the entry bar on. A stop triggers when the exit side of
   the
   quote touches it (bid for longs = low − half spread) and fills at the stop; a gap through the
   stop
   at the open fills at the open's taker price. A target (limit) fills at its price when the exit
   side
   reaches it. If a bar touches both, the **stop is assumed first**.
4. Trailing stops tighten on the close and apply from the next bar. Time stops and exit
   conditions exit
   at the next open. Positions still open at the end are closed at the last close (exit side, with
   commission) and flagged `end_of_data`.
5. Commission on every fill, overnight funding per 21:00 UTC roll (ACT/360), both from the
   registry cost
   model; amounts are converted to the account currency with `fxToBase`.

All amounts are float64 SIMULATED estimates (ADR 0005 §4); prices and quantities stay on the
registry
grid and are reported as strings.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

import numpy as np

from .costs import commission, fmt_price, quote, round_tick, snap_qty, swap, taker_price
from .dsl import (
    TIMEFRAME_SECONDS,
    AtrStop,
    FixedSize,
    Params,
    PercentStop,
    RiskPctSize,
    RTarget,
    StrategyDefinition,
    VolTargetSize,
)
from .evaluate import (
    CondEval,
    EvalContext,
    SymbolInput,
    compute_features,
    entry_ok,
    evaluate_entry,
    evaluate_exit,
    exit_hit,
    feature_keys,
    verify_point_in_time,
)

DAY_MS = 86_400_000
Action = Literal["enter_long", "enter_short", "exit", "hold", "blocked"]


def bars_per_year(tf_seconds: int) -> float:
    return 365.0 * 86_400 / tf_seconds


@dataclass
class PositionState:
    """What the decision needs to know about an open position (engine or live robot)."""

    side: int  # +1 long, -1 short
    qty: Decimal
    entry_ref: float
    stop: float
    initial_stop: float
    target: float | None
    bars_held: int
    high_water: float  # best close since entry (lowest for shorts)


@dataclass
class Decision:
    action: Action
    reason: str
    conditions: list[CondEval]
    qty: Decimal = Decimal(0)
    stop_distance: float | None = None
    target_distance: float | None = None
    new_stop: float | None = None
    ref_close: float = 0.0


def stop_distance(ctx: EvalContext, t: int) -> float:
    s = ctx.d.exit.stop
    close = float(ctx.sym.bars.c[t])
    if isinstance(s, AtrStop):
        a = float(ctx.features[f"atr:{ctx.p.period(s.period)}"][t])
        return a * ctx.p.num(s.multiple)
    if not (isinstance(s, PercentStop)):  # pragma: no cover - type narrowing
        raise TypeError("unexpected DSL shape")
    return close * ctx.p.num(s.pct) / 100.0


def target_distance(ctx: EvalContext, t: int, dist: float) -> float | None:
    tg = ctx.d.exit.target
    if tg is None:
        return None
    if isinstance(tg, AtrStop):
        return float(ctx.features[f"atr:{ctx.p.period(tg.period)}"][t]) * ctx.p.num(tg.multiple)
    if isinstance(tg, RTarget):
        return dist * ctx.p.num(tg.multiple)
    if not (isinstance(tg, PercentStop)):  # pragma: no cover - type narrowing
        raise TypeError("unexpected DSL shape")
    return float(ctx.sym.bars.c[t]) * ctx.p.num(tg.pct) / 100.0


def size_qty(ctx: EvalContext, t: int, equity: float, dist: float, bpy: float) -> Decimal:
    cm = ctx.sym.cost
    z = ctx.d.size
    if isinstance(z, FixedSize):
        return snap_qty(float(z.qty), cm)
    per_unit = dist * cm.multiplier * cm.fx_to_base
    if isinstance(z, RiskPctSize):
        if per_unit <= 0 or not math.isfinite(per_unit):
            return Decimal(0)
        return snap_qty(equity * ctx.p.num(z.pct) / 100.0 / per_unit, cm)
    if not (isinstance(z, VolTargetSize)):  # pragma: no cover - type narrowing
        raise TypeError("unexpected DSL shape")
    vol = float(ctx.features[f"realised_vol:{ctx.p.period(z.lookback)}"][t]) / 100.0
    close = float(ctx.sym.bars.c[t])
    if not math.isfinite(vol) or vol <= 0:
        return Decimal(0)
    notional = equity * ctx.p.num(z.annual_vol_pct) / 100.0 / vol
    return snap_qty(notional / (close * cm.multiplier * cm.fx_to_base), cm)


def trailing_stop(ctx: EvalContext, t: int, pos: PositionState) -> float | None:
    tr = ctx.d.exit.trailing
    if tr is None:
        return None
    risk = abs(pos.entry_ref - pos.initial_stop)
    if risk <= 0:
        return None
    gained = (pos.high_water - pos.entry_ref) * pos.side
    if gained < ctx.p.num(tr.after_r) * risk:
        return None
    a = float(ctx.features[f"atr:{ctx.p.period(tr.period)}"][t])
    if not math.isfinite(a):
        return None
    tick = ctx.sym.cost.tick_size
    if pos.side > 0:
        cand = round_tick(pos.high_water - a * ctx.p.num(tr.multiple), tick, "down")
        return cand if cand > pos.stop else None
    cand = round_tick(pos.high_water + a * ctx.p.num(tr.multiple), tick, "up")
    return cand if cand < pos.stop else None


def decide(
    ctx: EvalContext,
    t: int,
    pos: PositionState | None,
    equity: float,
    open_positions: int,
    bpy: float,
) -> Decision:
    """The strategy's decision on the close of bar t (shared by the backtester and the live bot)."""
    close = float(ctx.sym.bars.c[t])
    if pos is not None:
        conds = evaluate_exit(ctx, t)
        new_stop = trailing_stop(ctx, t, pos)
        ts = ctx.d.exit.time_stop_bars
        if exit_hit(conds):
            return Decision("exit", "exit_signal", conds, new_stop=new_stop, ref_close=close)
        if ts is not None and pos.bars_held >= ctx.p.period(ts):
            return Decision("exit", "time_stop", conds, new_stop=new_stop, ref_close=close)
        return Decision("hold", "in_position", conds, new_stop=new_stop, ref_close=close)
    conds = evaluate_entry(ctx, t)
    if not entry_ok(conds):
        return Decision("hold", "conditions_not_met", conds, ref_close=close)
    action: Action = "enter_long" if ctx.d.entry.side == "long" else "enter_short"
    if open_positions >= ctx.d.size.max_open_positions:
        return Decision("blocked", "max_open_positions", conds, ref_close=close)
    dist = stop_distance(ctx, t)
    if not math.isfinite(dist) or dist <= 0:
        return Decision("blocked", "stop_distance_unavailable", conds, ref_close=close)
    qty = size_qty(ctx, t, equity, dist, bpy)
    if qty <= 0 or qty < Decimal(ctx.sym.cost.min_qty):
        return Decision("blocked", "size_below_minimum", conds, ref_close=close)
    return Decision(
        action,
        "entry_signal",
        conds,
        qty=qty,
        stop_distance=dist,
        target_distance=target_distance(ctx, t, dist),
        ref_close=close,
    )


# ---- Portfolio simulation
# -------------------------------------------------------------------------


@dataclass
class Fill:
    ts: int
    symbol: str
    side: Literal["buy", "sell"]
    qty: Decimal
    price: float
    notional_base: float
    commission_base: float
    spread_base: float
    role: Literal["entry", "exit"]


@dataclass
class _Pos:
    state: PositionState
    symbol: str
    entry_ts: int
    entry_price: float
    entry_signal: dict[str, object]
    commission_base: float = 0.0
    swap_base: float = 0.0
    decision_ts: int = 0


@dataclass
class Trade:
    symbol: str
    side: Literal["long", "short"]
    qty: str
    entry_ts: int
    entry_price: str
    exit_ts: int
    exit_price: str
    reason: str
    stop_initial: str
    target: str | None
    gross_pnl: float
    commission: float
    swap: float
    net_pnl: float
    r_multiple: float
    bars_held: int
    entry_signal: dict[str, object]

    def to_wire(self) -> dict[str, object]:
        return {
            "symbol": self.symbol,
            "side": self.side,
            "qty": self.qty,
            "entryTs": self.entry_ts,
            "entryPrice": self.entry_price,
            "exitTs": self.exit_ts,
            "exitPrice": self.exit_price,
            "reason": self.reason,
            "stopInitial": self.stop_initial,
            "target": self.target,
            "grossPnl": round(self.gross_pnl, 6),
            "commission": round(self.commission, 6),
            "swap": round(self.swap, 6),
            "netPnl": round(self.net_pnl, 6),
            "rMultiple": round(self.r_multiple, 6),
            "barsHeld": self.bars_held,
            "entrySignal": self.entry_signal,
        }


@dataclass
class EngineResult:
    ts: np.ndarray  # bar close times (ms) of the portfolio timeline
    equity: np.ndarray
    in_market: np.ndarray
    trades: list[Trade]
    fills: list[Fill]
    swaps: list[tuple[int, float]]
    blocked: dict[str, int]
    guard_checkpoints: int
    capital: float
    signals: int = 0
    first_decision_ts: int = 0
    extra: dict[str, object] = field(default_factory=dict)


def _rolls(t1: int, t2: int, roll_hour: int) -> int:
    off = roll_hour * 3_600_000
    return (t2 - off) // DAY_MS - (t1 - off) // DAY_MS


def run(
    d: StrategyDefinition,
    p: Params,
    symbols: list[SymbolInput],
    capital: float,
    *,
    guard: bool = True,
    roll_hour: int = 21,
) -> EngineResult:
    tf_s = TIMEFRAME_SECONDS[d.universe.timeframe]
    tf_ms = tf_s * 1000
    bpy = bars_per_year(tf_s)
    keys = feature_keys(d, p)
    ctxs: dict[str, EvalContext] = {}
    checkpoints = 0
    for s in symbols:
        feats = compute_features(s.bars, keys, bpy)
        if guard:
            checkpoints += verify_point_in_time(s.bars, keys, bpy, feats)
        ctxs[s.symbol] = EvalContext(d, p, s, feats, tf_s)
    index = {s.symbol: {int(t): i for i, t in enumerate(s.bars.t)} for s in symbols}
    timeline = sorted({int(t) for s in symbols for t in s.bars.t})

    cash = capital
    positions: dict[str, _Pos] = {}
    pending: dict[str, tuple[str, Decision, int]] = {}
    trades: list[Trade] = []
    fills: list[Fill] = []
    swaps: list[tuple[int, float]] = []
    blocked: dict[str, int] = {}
    eq = np.empty(len(timeline))
    in_mkt = np.zeros(len(timeline), dtype=bool)
    last_close: dict[str, float] = {}
    signals = 0

    def record_fill(
        ts: int,
        sym: SymbolInput,
        side: Literal["buy", "sell"],
        qty: Decimal,
        price: float,
        mid: float,
        role: Literal["entry", "exit"],
    ) -> float:
        cm = sym.cost
        q = float(qty)
        comm = commission(q, price, cm) * cm.fx_to_base
        fills.append(
            Fill(
                ts=ts,
                symbol=sym.symbol,
                side=side,
                qty=qty,
                price=price,
                notional_base=q * price * cm.multiplier * cm.fx_to_base,
                commission_base=comm,
                spread_base=abs(price - mid) * q * cm.multiplier * cm.fx_to_base,
                role=role,
            )
        )
        return comm

    def close_pos(pos: _Pos, ts: int, price: float, mid: float, reason: str) -> None:
        nonlocal cash
        sym = ctxs[pos.symbol].sym
        cm = sym.cost
        st = pos.state
        side: Literal["buy", "sell"] = "sell" if st.side > 0 else "buy"
        comm = record_fill(ts, sym, side, st.qty, price, mid, "exit")
        q = float(st.qty)
        gross = st.side * (price - pos.entry_price) * q * cm.multiplier * cm.fx_to_base
        cash += gross - comm
        total_comm = pos.commission_base + comm
        net = gross - total_comm + pos.swap_base
        risk = abs(st.entry_ref - st.initial_stop) * q * cm.multiplier * cm.fx_to_base
        trades.append(
            Trade(
                symbol=pos.symbol,
                side="long" if st.side > 0 else "short",
                qty=format(st.qty.normalize(), "f"),
                entry_ts=pos.entry_ts,
                entry_price=fmt_price(pos.entry_price, cm),
                exit_ts=ts,
                exit_price=fmt_price(price, cm),
                reason=reason,
                stop_initial=fmt_price(st.initial_stop, cm),
                target=None if st.target is None else fmt_price(st.target, cm),
                gross_pnl=gross,
                commission=total_comm,
                swap=pos.swap_base,
                net_pnl=net,
                r_multiple=net / risk if risk > 0 else 0.0,
                bars_held=st.bars_held,
                entry_signal=pos.entry_signal,
            )
        )
        del positions[pos.symbol]

    prev_close_ts: int | None = None
    for k, bar_t in enumerate(timeline):
        for s in symbols:
            i = index[s.symbol].get(bar_t)
            if i is None:
                continue
            ctx = ctxs[s.symbol]
            b = s.bars
            cm = s.cost
            o, h, lo, c = float(b.o[i]), float(b.h[i]), float(b.lo[i]), float(b.c[i])
            gap = o - float(b.c[i - 1]) if i > 0 else 0.0
            hs = cm.half_spread
            entered_now = False
            pend = pending.pop(s.symbol, None)
            pos = positions.get(s.symbol)
            if pend and pend[0] == "exit" and pos is not None:
                side_x: Literal["buy", "sell"] = "sell" if pos.state.side > 0 else "buy"
                close_pos(pos, bar_t, taker_price(side_x, o, gap, cm), o, pend[1].reason)
                pos = None
            if pend and pend[0] == "entry" and pos is None:
                dec_ = pend[1]
                side_i = 1 if dec_.action == "enter_long" else -1
                bid, ask = quote(o, cm)
                ref = ask if side_i > 0 else bid
                buy_sell: Literal["buy", "sell"] = "buy" if side_i > 0 else "sell"
                price = taker_price(buy_sell, o, gap, cm)
                dist = dec_.stop_distance or 0.0
                stop = round_tick(ref - side_i * dist, cm.tick_size, "down" if side_i > 0 else "up")
                target = (
                    None
                    if dec_.target_distance is None
                    else round_tick(ref + side_i * dec_.target_distance, cm.tick_size, "nearest")
                )
                comm = record_fill(bar_t, s, buy_sell, dec_.qty, price, o, "entry")
                cash -= comm
                state = PositionState(side_i, dec_.qty, ref, stop, stop, target, 0, c)
                state.high_water = ref
                pos = _Pos(
                    state=state,
                    symbol=s.symbol,
                    entry_ts=bar_t,
                    entry_price=price,
                    entry_signal={
                        "barTs": pend[2],
                        "conditions": [e.to_wire() for e in dec_.conditions],
                    },
                    commission_base=comm,
                    decision_ts=pend[2],
                )
                positions[s.symbol] = pos
                entered_now = True
            if pos is not None:
                st = pos.state
                bid_o, ask_o = quote(o, cm)
                exit_o = bid_o if st.side > 0 else ask_o
                stop_reason = "trailing_stop" if st.stop != st.initial_stop else "stop"
                if not entered_now:
                    through_stop = exit_o <= st.stop if st.side > 0 else exit_o >= st.stop
                    through_tgt = st.target is not None and (
                        exit_o >= st.target if st.side > 0 else exit_o <= st.target
                    )
                    if through_stop:
                        side_g: Literal["buy", "sell"] = "sell" if st.side > 0 else "buy"
                        close_pos(pos, bar_t, taker_price(side_g, o, gap, cm), o, stop_reason)
                        pos = None
                    elif through_tgt:
                        close_pos(pos, bar_t, float(st.target or 0.0), o, "target")
                        pos = None
                if pos is not None:
                    st = pos.state
                    if st.side > 0:
                        stop_hit = lo - hs <= st.stop
                        tgt_hit = st.target is not None and h - hs >= st.target
                    else:
                        stop_hit = h + hs >= st.stop
                        tgt_hit = st.target is not None and lo + hs <= st.target
                    if stop_hit:
                        close_pos(pos, bar_t, st.stop, o, stop_reason)
                        pos = None
                    elif tgt_hit:
                        close_pos(pos, bar_t, float(st.target or 0.0), o, "target")
                        pos = None
            last_close[s.symbol] = c
            # Decision on the close.
            if pos is not None:
                st = pos.state
                st.bars_held += 1
                st.high_water = max(st.high_water, c) if st.side > 0 else min(st.high_water, c)
                dx = decide(ctx, i, st, 0.0, 0, bpy)
                if dx.new_stop is not None:
                    st.stop = dx.new_stop
                if dx.action == "exit":
                    pending[s.symbol] = ("exit", dx, bar_t)
            elif s.symbol not in pending:
                equity_now = cash + _unrealised(positions, ctxs, last_close)
                open_n = len(positions) + sum(1 for v in pending.values() if v[0] == "entry")
                dx = decide(ctx, i, None, equity_now, open_n, bpy)
                if dx.action in ("enter_long", "enter_short"):
                    signals += 1
                    if i + 1 < len(b):
                        pending[s.symbol] = ("entry", dx, bar_t)
                elif dx.action == "blocked":
                    blocked[dx.reason] = blocked.get(dx.reason, 0) + 1
        close_ts = bar_t + tf_ms
        if prev_close_ts is not None and positions:
            nights = _rolls(prev_close_ts, close_ts, roll_hour)
            if nights > 0:
                for pos in positions.values():
                    cmx = ctxs[pos.symbol].sym.cost
                    amt = (
                        swap(
                            float(pos.state.qty) * pos.state.side,
                            last_close[pos.symbol],
                            cmx,
                            nights,
                        )
                        * cmx.fx_to_base
                    )
                    pos.swap_base += amt
                    cash += amt
                    swaps.append((close_ts, amt))
        prev_close_ts = close_ts
        eq[k] = cash + _unrealised(positions, ctxs, last_close)
        in_mkt[k] = bool(positions)

    if positions and timeline:
        end_t = timeline[-1] + tf_ms
        for pos in list(positions.values()):
            cmx = ctxs[pos.symbol].sym.cost
            mid = last_close[pos.symbol]
            bid, ask = quote(mid, cmx)
            close_pos(pos, end_t, bid if pos.state.side > 0 else ask, mid, "end_of_data")
        eq[-1] = cash
    return EngineResult(
        ts=np.array([t + tf_ms for t in timeline], dtype=np.int64),
        equity=eq,
        in_market=in_mkt,
        trades=trades,
        fills=fills,
        swaps=swaps,
        blocked=blocked,
        guard_checkpoints=checkpoints,
        capital=capital,
        signals=signals,
    )


def _unrealised(
    positions: dict[str, _Pos], ctxs: dict[str, EvalContext], last_close: dict[str, float]
) -> float:
    total = 0.0
    for pos in positions.values():
        cm = ctxs[pos.symbol].sym.cost
        mid = last_close.get(pos.symbol)
        if mid is None:
            continue
        bid, ask = quote(mid, cm)
        mark = bid if pos.state.side > 0 else ask
        total += (
            pos.state.side
            * (mark - pos.entry_price)
            * float(pos.state.qty)
            * cm.multiplier
            * cm.fx_to_base
        )
    return total
