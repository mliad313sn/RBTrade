"""Condition evaluation, per-signal features and contributions, and the look-ahead guard.

Conditions are tri-state: True, False or "not_available" (warm-up NaN, no session/calendar data, or
the AI regime filter before goal 07). Contributions are a transparent heuristic, not a model
attribution: the signed distance of each condition from its threshold, scaled (ATR for price-like
operands, 10 points for RSI/ADX, 1 unit otherwise) and squashed with tanh into [-1, 1], positive
when
it supports the action. They are stored with every signal for explainability (goal 07).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal
from zoneinfo import ZoneInfo

import numpy as np
from numpy.typing import NDArray

from . import indicators as ind
from .costs import CostModel
from .dsl import (
    AiRegimeCondition,
    AtrStop,
    CompareCondition,
    Condition,
    ConstOperand,
    CrossCondition,
    IndicatorOperand,
    NoEventCondition,
    Operand,
    Params,
    SessionWindowCondition,
    StrategyDefinition,
    VenueOpenCondition,
    VolTargetSize,
)

Result = bool | Literal["not_available"]
NA: Literal["not_available"] = "not_available"
SCALE_KEY = "atr:14"
LABELS = {
    "close": "Close",
    "open": "Open",
    "high": "High",
    "low": "Low",
    "volume": "Volume",
    "ema": "EMA",
    "sma": "SMA",
    "rsi": "RSI",
    "atr": "ATR",
    "adx": "ADX",
    "roc": "ROC %",
    "highest": "Highest high",
    "lowest": "Lowest low",
    "realised_vol": "Realised vol %",
}
OP_SYMBOL = {"gt": ">", "gte": "≥", "lt": "<", "lte": "≤"}


class LookAheadError(RuntimeError):
    """A feature at bar t changed when bars after t were removed: the run used future data."""


@dataclass
class SymbolInput:
    symbol: str
    bars: ind.Bars
    cost: CostModel
    session_open: NDArray[np.bool_] | None = None
    events: NDArray[np.int64] | None = None


@dataclass
class CondEval:
    block: Literal["entry", "filter", "exit"]
    index: int
    type: str
    label: str
    result: Result
    values: dict[str, float | None] = field(default_factory=dict)
    contribution: float | None = None
    skipped: bool = False

    def to_wire(self) -> dict[str, object]:
        return {
            "block": self.block,
            "index": self.index,
            "type": self.type,
            "label": self.label,
            "result": self.result,
            "values": self.values,
            "contribution": self.contribution,
            "skipped": self.skipped,
        }


def operand_key(o: Operand, p: Params) -> str | None:
    if isinstance(o, ConstOperand):
        return None
    if o.period is None:
        return o.name
    return f"{o.name}:{p.period(o.period)}"


def _conditions(d: StrategyDefinition) -> list[Condition]:
    return [*d.entry.conditions, *d.filters, *d.exit.conditions]


def feature_keys(d: StrategyDefinition, p: Params) -> list[str]:
    keys: set[str] = {SCALE_KEY, "close"}
    for c in _conditions(d):
        if isinstance(c, CompareCondition | CrossCondition):
            for o in (c.left, c.right):
                k = operand_key(o, p)
                if k:
                    keys.add(k)
    for blk in (d.exit.stop, d.exit.target, d.exit.trailing):
        if isinstance(blk, AtrStop) or (blk is not None and getattr(blk, "kind", "") == "atr"):
            keys.add(f"atr:{p.period(blk.period)}")  # type: ignore[union-attr]
    if isinstance(d.size, VolTargetSize):
        keys.add(f"realised_vol:{p.period(d.size.lookback)}")
    return sorted(keys)


def compute_features(bars: ind.Bars, keys: list[str], bars_per_year: float) -> dict[str, ind.F]:
    out: dict[str, ind.F] = {}
    for k in keys:
        name, _, n = k.partition(":")
        out[k] = ind.REGISTRY[name](bars, int(n) if n else 0, bars_per_year)
    return out


def verify_point_in_time(
    bars: ind.Bars,
    keys: list[str],
    bars_per_year: float,
    full: dict[str, ind.F],
    checkpoints: int = 8,
) -> int:
    """Recomputes features on prefixes bars[:t+1] and compares them with row t of the full run.

    Raises LookAheadError on any difference. Returns the number of checkpoints verified.
    """
    n = len(bars)
    if n == 0:
        return 0
    points = sorted({int(x) for x in np.linspace(0, n - 1, num=min(checkpoints, n))} | {n - 1})
    for t in points:
        part = compute_features(bars.prefix(t + 1), keys, bars_per_year)
        for k in keys:
            a, b = full[k][t], part[k][t]
            same = (math.isnan(a) and math.isnan(b)) or (
                not math.isnan(a)
                and not math.isnan(b)
                and math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)
            )
            if not same:
                raise LookAheadError(
                    f"Look-ahead detected: feature {k} at bar {t} is {a} with the full series "
                    f"but {b} "
                    "with only the bars up to it. The run used future data and was stopped."
                )
    return len(points)


def _num_label(v: object, p: Params) -> str:
    try:
        x = p.num(v)  # type: ignore[arg-type]
    except ValueError:
        return "?"
    return str(int(x)) if float(x).is_integer() else f"{x:g}"


def operand_label(o: Operand, p: Params) -> str:
    if isinstance(o, ConstOperand):
        return _num_label(o.value, p)
    base = LABELS[o.name]
    return base if o.period is None else f"{base} {_num_label(o.period, p)}"


def condition_label(c: Condition, p: Params) -> str:
    if isinstance(c, CompareCondition):
        return f"{operand_label(c.left, p)} {OP_SYMBOL[c.op]} {operand_label(c.right, p)}"
    if isinstance(c, CrossCondition):
        return f"{operand_label(c.left, p)} crosses {c.direction} {operand_label(c.right, p)}"
    if isinstance(c, SessionWindowCondition):
        return f"{c.label or 'Session'} {c.start}–{c.end} ({c.timezone})"
    if isinstance(c, VenueOpenCondition):
        return "Venue open"
    if isinstance(c, NoEventCondition):
        return f"No high-impact event within {_num_label(c.within_minutes, p)} min"
    return f"AI regime = {c.regime} (p > {_num_label(c.min_probability, p)})"


@dataclass
class EvalContext:
    d: StrategyDefinition
    p: Params
    sym: SymbolInput
    features: dict[str, ind.F]
    tf_seconds: int

    def value(self, o: Operand, t: int) -> float:
        if isinstance(o, ConstOperand):
            return self.p.num(o.value)
        k = operand_key(o, self.p)
        if not (k is not None):  # pragma: no cover - type narrowing
            raise TypeError("unexpected DSL shape")
        return float(self.features[k][t])

    def scale(self, o: Operand, t: int) -> float:
        name = o.name if isinstance(o, IndicatorOperand) else ""
        if name in ind.PRICE_LIKE:
            s = float(self.features[SCALE_KEY][t])
            if math.isfinite(s) and s > 0:
                return s
            # ATR still warming up: 1 % of the price as the scale.
            px = abs(float(self.sym.bars.c[t]))
            return px * 0.01 if px > 0 else float("nan")
        if name in ind.OSCILLATORS:
            return 10.0
        return 1.0


def _squash(margin: float, scale: float) -> float | None:
    if not math.isfinite(margin) or not math.isfinite(scale) or scale <= 0:
        return None
    return round(math.tanh(margin / scale), 4)


def _price_scale(ctx: EvalContext, c: CompareCondition | CrossCondition, t: int) -> float:
    left_s = ctx.scale(c.left, t)
    right_s = ctx.scale(c.right, t)
    if isinstance(c.left, ConstOperand):
        return right_s
    return left_s if not isinstance(c.right, IndicatorOperand) else max(left_s, right_s)


def _fmt(x: float) -> float | None:
    return None if not math.isfinite(x) else round(x, 10)


def eval_condition(
    c: Condition, block: Literal["entry", "filter", "exit"], index: int, t: int, ctx: EvalContext
) -> CondEval:
    label = condition_label(c, ctx.p)
    ev = CondEval(block=block, index=index, type=c.type, label=label, result=NA)
    if isinstance(c, CompareCondition | CrossCondition):
        lv, rv = ctx.value(c.left, t), ctx.value(c.right, t)
        ev.values = {
            operand_label(c.left, ctx.p): _fmt(lv),
            operand_label(c.right, ctx.p): _fmt(rv),
        }
        if math.isnan(lv) or math.isnan(rv):
            return ev
        scale = _price_scale(ctx, c, t)
        if isinstance(c, CompareCondition):
            ev.result = {
                "gt": lv > rv,
                "gte": lv >= rv,
                "lt": lv < rv,
                "lte": lv <= rv,
            }[c.op]
            margin = lv - rv if c.op in ("gt", "gte") else rv - lv
        else:
            if t < 1:
                return ev
            lp, rp = ctx.value(c.left, t - 1), ctx.value(c.right, t - 1)
            if math.isnan(lp) or math.isnan(rp):
                return ev
            if c.direction == "above":
                ev.result = lp <= rp and lv > rv
                margin = lv - rv
            else:
                ev.result = lp >= rp and lv < rv
                margin = rv - lv
        ev.contribution = _squash(margin, scale)
        return ev
    close_ts = int(ctx.sym.bars.t[t]) + ctx.tf_seconds * 1000
    if isinstance(c, SessionWindowCondition):
        local = datetime.fromtimestamp(close_ts / 1000, tz=UTC).astimezone(ZoneInfo(c.timezone))
        hhmm = local.strftime("%H:%M")
        inside = c.start <= hhmm < c.end if c.start <= c.end else hhmm >= c.start or hhmm < c.end
        if c.days:
            inside = inside and local.isoweekday() in c.days
        ev.result = inside
        ev.values = {"localTime": None}
        return ev
    if isinstance(c, VenueOpenCondition):
        if ctx.sym.session_open is None:
            return ev
        ev.result = bool(ctx.sym.session_open[t])
        return ev
    if isinstance(c, NoEventCondition):
        if ctx.sym.events is None:
            return ev
        window = ctx.p.num(c.within_minutes) * 60_000
        ev_arr = ctx.sym.events
        lo = int(np.searchsorted(ev_arr, close_ts - window, side="left"))
        hi = int(np.searchsorted(ev_arr, close_ts + window, side="right"))
        ev.result = hi <= lo
        ev.values = {"eventsInWindow": float(hi - lo)}
        return ev
    if not (isinstance(c, AiRegimeCondition)):  # pragma: no cover - type narrowing
        raise TypeError("unexpected DSL shape")
    # Goal 07 supplies the regime model. Until then: "not available", skipped or blocking by choice.
    ev.values = {"probability": None}
    ev.skipped = c.when_unavailable == "ignore"
    return ev


def entry_ok(evals: list[CondEval]) -> bool:
    return all(e.result is True or (e.result == NA and e.skipped) for e in evals)


def exit_hit(evals: list[CondEval]) -> bool:
    return any(e.result is True for e in evals)


def evaluate_entry(ctx: EvalContext, t: int) -> list[CondEval]:
    d = ctx.d
    out = [eval_condition(c, "entry", i, t, ctx) for i, c in enumerate(d.entry.conditions)]
    out += [eval_condition(c, "filter", i, t, ctx) for i, c in enumerate(d.filters)]
    return out


def evaluate_exit(ctx: EvalContext, t: int) -> list[CondEval]:
    return [eval_condition(c, "exit", i, t, ctx) for i, c in enumerate(ctx.d.exit.conditions)]
