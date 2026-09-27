"""Research orchestration: IS/OOS backtest, walk-forward, optimisation, sensitivity, live signal."""

from __future__ import annotations

import itertools
import math
import time
from decimal import Decimal
from typing import Any

import numpy as np

from . import indicators as ind
from .costs import fmt_price
from .dsl import TIMEFRAME_SECONDS, Params, StrategyDefinition
from .dsr import deflated_sharpe
from .engine import EngineResult, PositionState, Trade, bars_per_year, decide, run
from .evaluate import (
    EvalContext,
    SymbolInput,
    compute_features,
    feature_keys,
    verify_point_in_time,
)
from .metrics import compute_metrics, segment_metrics
from .models import (
    BacktestRunRequest,
    OptimiseRequest,
    ResearchBase,
    SensitivityRequest,
    SignalRequest,
    SymbolData,
    WalkForwardRequest,
    max_combos,
)

MIN_OOS_TRADES = 100
DISCLAIMER = (
    "SIMULATED backtest on SIMULATED data with the registry cost model. "
    "Past or simulated results do "
    "not predict future returns and are not investment advice."
)


class ResearchError(ValueError):
    """Plain-language refusal (mapped to HTTP 422)."""


def parse_definition(raw: dict[str, Any]) -> StrategyDefinition:
    return StrategyDefinition.model_validate(raw)


def to_input(sd: SymbolData, end_ts: int | None = None) -> SymbolInput:
    b = sd.bars
    n = len(b.t) if end_ts is None else int(np.searchsorted(np.asarray(b.t), end_ts, side="left"))
    bars = ind.Bars(
        np.asarray(b.t[:n], dtype=np.int64),
        np.asarray(b.o[:n], dtype=np.float64),
        np.asarray(b.h[:n], dtype=np.float64),
        np.asarray(b.l[:n], dtype=np.float64),
        np.asarray(b.c[:n], dtype=np.float64),
        np.asarray(b.v[:n], dtype=np.float64),
    )
    return SymbolInput(
        symbol=sd.symbol,
        bars=bars,
        cost=sd.costs,
        session_open=None
        if sd.session_open is None
        else np.asarray(sd.session_open[:n], dtype=bool),
        events=None if sd.events is None else np.asarray(sorted(sd.events), dtype=np.int64),
    )


def timeline(data: list[SymbolData]) -> list[int]:
    return sorted({t for sd in data for t in sd.bars.t})


def oos_start(req: ResearchBase) -> int:
    tl = timeline(req.data)
    if len(tl) < 10:
        raise ResearchError(f"Only {len(tl)} bars: a backtest needs at least 10.")
    if req.split.oos_start is not None:
        return req.split.oos_start
    return tl[min(len(tl) - 1, int(len(tl) * (1.0 - req.split.oos_fraction)))]


def _run(
    req: ResearchBase,
    overrides: dict[str, float],
    end_ts: int | None = None,
    guard: bool = True,
) -> EngineResult:
    d = parse_definition(req.definition)
    try:
        p = Params(d.params, {**req.param_overrides, **overrides})
        return run(
            d,
            p,
            [to_input(sd, end_ts) for sd in req.data],
            req.capital,
            guard=guard,
            roll_hour=req.roll_hour_utc,
            ai_regime=req.ai_regime == "model",
        )
    except ValueError as exc:
        if exc.__class__ is not ValueError:
            raise
        raise ResearchError(str(exc)) from exc


def _downsample(res: EngineResult, max_points: int) -> dict[str, Any]:
    n = len(res.ts)
    idx = (
        np.unique(np.linspace(0, n - 1, num=min(n, max_points)).astype(int))
        if n
        else np.array([], int)
    )
    eq = res.equity
    peak = np.maximum.accumulate(np.r_[res.capital, eq])[1:] if n else eq
    dd = eq / peak - 1.0 if n else eq
    return {
        "t": [int(x) for x in res.ts[idx]],
        "equity": [round(float(x), 2) for x in eq[idx]],
        "drawdown": [round(float(x), 6) for x in dd[idx]],
    }


def _warnings(
    is_m: dict[str, Any], oos_m: dict[str, Any], res: EngineResult
) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if oos_m["trades"] < MIN_OOS_TRADES:
        out.append(
            {
                "code": "oos_trades_low",
                "message": f"Only {oos_m['trades']} out-of-sample trades "
                f"(fewer than {MIN_OOS_TRADES}): "
                "too few to tell skill from luck.",
            }
        )
    s_is, s_oos = is_m.get("sharpe"), oos_m.get("sharpe")
    if s_is is not None and s_is > 0 and (s_oos is None or s_oos < 0.5 * s_is):
        out.append(
            {
                "code": "oos_sharpe_decay",
                "message": "Out-of-sample Sharpe is below half of the in-sample Sharpe: "
                "the in-sample "
                "result is likely overfitted.",
            }
        )
    if not res.trades:
        out.append({"code": "no_trades", "message": "The strategy did not trade on this data."})
    return out


def _overfitting(is_m: dict[str, Any], trials: int, sharpes: list[float]) -> dict[str, Any]:
    sr = is_m.get("periodSharpe")
    var = float(np.var(sharpes, ddof=1)) if len(sharpes) > 1 else 0.0
    if sr is None or is_m.get("skew") is None:
        return {
            "trials": trials,
            "dsr": None,
            "sr0": None,
            "trialSharpeVariance": var,
            "basis": "in_sample",
        }
    dsr, sr0 = deflated_sharpe(
        sr, int(is_m["observations"]), float(is_m["skew"]), float(is_m["kurtosis"]), trials, var
    )
    return {
        "trials": trials,
        "dsr": None if dsr is None else round(dsr, 4),
        "sr0": round(sr0, 6),
        "trialSharpeVariance": var,
        "basis": "in_sample",
    }


def _holdout_overfitting(
    oos_m: dict[str, Any], trials: int, sharpes: list[float]
) -> dict[str, Any]:
    """DSR of the out-of-sample holdout, deflated by every trial recorded for the strategy
    (IRTC R3-02: the promotion gate reads this basis, recomputed by the api at check time)."""
    var = float(np.var(sharpes, ddof=1)) if len(sharpes) > 1 else 0.0
    sr = oos_m.get("periodSharpe")
    base = {"trials": trials, "trialSharpeVariance": var, "basis": "out_of_sample_holdout"}
    if sr is None or oos_m.get("skew") is None or oos_m.get("kurtosis") is None:
        return {**base, "dsr": None, "sr0": None, "observations": oos_m.get("observations")}
    dsr, sr0 = deflated_sharpe(
        sr, int(oos_m["observations"]), float(oos_m["skew"]), float(oos_m["kurtosis"]), trials, var
    )
    return {
        **base,
        "dsr": None if dsr is None else round(dsr, 4),
        "sr0": round(sr0, 6),
        "observations": oos_m.get("observations"),
    }


def _trial_stat(
    values: dict[str, float], is_m: dict[str, Any], oos_m: dict[str, Any]
) -> dict[str, Any]:
    return {
        "params": values,
        "isPeriodSharpe": is_m.get("periodSharpe"),
        "oosPeriodSharpe": oos_m.get("periodSharpe"),
        "isSharpe": is_m.get("sharpe"),
        "oosSharpe": oos_m.get("sharpe"),
        "isTrades": is_m["trades"],
        "oosTrades": oos_m["trades"],
        "observations": is_m.get("observations"),
    }


def _trade_wire(t: Trade, split_ts: int | None) -> dict[str, Any]:
    w = t.to_wire()
    w["segment"] = "oos" if split_ts is not None and t.entry_ts >= split_ts else "is"
    return w


def backtest(req: BacktestRunRequest) -> dict[str, Any]:
    t0 = time.perf_counter()
    split = oos_start(req)
    d = parse_definition(req.definition)
    res = _run(req, {}, guard=req.guard)
    is_m = segment_metrics(res, None, split)
    oos_m = segment_metrics(res, split, None)
    all_m = segment_metrics(res, None, None)
    values = Params(d.params, req.param_overrides).values
    stat = _trial_stat(values, is_m, oos_m)
    sharpes = [*req.trials.period_sharpes]
    if stat["isPeriodSharpe"] is not None:
        sharpes.append(stat["isPeriodSharpe"])
    trials = max(1, req.trials.count + 1)
    return {
        "simulated": True,
        "disclaimer": DISCLAIMER,
        "strategy": d.name,
        "timeframe": d.universe.timeframe,
        "symbols": [sd.symbol for sd in req.data],
        "capital": req.capital,
        "oosStart": split,
        "metrics": {"inSample": is_m, "outOfSample": oos_m, "all": all_m},
        "warnings": _warnings(is_m, oos_m, res),
        "overfitting": {
            **_overfitting(is_m, trials, sharpes),
            "holdout": _holdout_overfitting(oos_m, trials, sharpes),
        },
        "equity": _downsample(res, req.max_points),
        "trades": [_trade_wire(t, split) for t in res.trades],
        "blocked": res.blocked,
        "signals": res.signals,
        "guard": {"checkpoints": res.guard_checkpoints, "passed": True, "enabled": req.guard},
        "trialStats": [stat],
        "costs": {sd.symbol: sd.costs.model_dump(by_alias=True) for sd in req.data},
        "params": values,
        "elapsedMs": round((time.perf_counter() - t0) * 1000, 1),
    }


def _combos(grid: dict[str, list[float]]) -> list[dict[str, float]]:
    names = sorted(grid)
    return [
        dict(zip(names, vals, strict=True)) for vals in itertools.product(*(grid[n] for n in names))
    ]


def _cap(n: int, requested: int | None) -> int:
    cap = min(max_combos(), requested or max_combos())
    if n > cap:
        raise ResearchError(
            f"{n} parameter combinations requested; the limit is {cap}. "
            "Narrow the grid or use random search."
        )
    return cap


def validation_start(req: ResearchBase, split: int, fraction: float) -> int:
    """Start of the inner validation segment: the last `fraction` of the bars before the holdout.

    Selection (optimisation, heatmap) is scored on [validation_start, split); the holdout
    [split, end) is never read while choosing (IRTC R3-01)."""
    pre = [t for t in timeline(req.data) if t < split]
    if len(pre) < 20:
        raise ResearchError(
            f"Only {len(pre)} bars before the out-of-sample holdout: selection needs at least 20 "
            "(in-sample plus validation). Use more data or a smaller out-of-sample share."
        )
    return pre[min(len(pre) - 1, max(1, int(len(pre) * (1.0 - fraction))))]


def _score(
    req: ResearchBase, over: dict[str, float], split: int, vsplit: int
) -> tuple[dict[str, Any], dict[str, Any]]:
    """In-sample and validation metrics on data truncated at the holdout start: the engine never
    receives a holdout bar while a configuration is being scored."""
    res = _run(req, over, end_ts=split, guard=True)
    return segment_metrics(res, None, vsplit), segment_metrics(res, vsplit, None)


def _holdout(req: ResearchBase, over: dict[str, float], split: int) -> dict[str, Any]:
    """The single out-of-sample evaluation of the selected configuration."""
    res = _run(req, over, guard=True)
    return segment_metrics(res, split, None)


def _selection_stat(
    values: dict[str, float], is_m: dict[str, Any], val_m: dict[str, Any]
) -> dict[str, Any]:
    stat = _trial_stat(values, is_m, {"periodSharpe": None, "sharpe": None, "trades": 0})
    stat["validationPeriodSharpe"] = val_m.get("periodSharpe")
    stat["validationSharpe"] = val_m.get("sharpe")
    return stat


SELECTION_NOTE = (
    "Ranked on the validation segment (the end of the in-sample window). The out-of-sample "
    "holdout was not read while ranking; it is reported once, for the selected configuration."
)


def optimise(req: OptimiseRequest) -> dict[str, Any]:
    t0 = time.perf_counter()
    split = oos_start(req)
    vsplit = validation_start(req, split, req.validation_fraction)
    d = parse_definition(req.definition)
    for name in req.grid:
        if name not in d.params:
            raise ResearchError(f'Unknown parameter "{name}" in the grid.')
    all_combos = _combos(req.grid)
    if req.method == "grid":
        _cap(len(all_combos), req.max_combos)
        combos = all_combos
    else:
        cap = min(max_combos(), req.max_combos or max_combos())
        k = min(req.samples, cap, len(all_combos))
        rng = np.random.default_rng(req.seed)
        combos = [
            all_combos[int(i)] for i in sorted(rng.choice(len(all_combos), size=k, replace=False))
        ]
    rows: list[dict[str, Any]] = []
    stats: list[dict[str, Any]] = []
    base = Params(d.params, req.param_overrides).values
    for over in combos:
        is_m, val_m = _score(req, over, split, vsplit)
        values = {**base, **over}
        stats.append(_selection_stat(values, is_m, val_m))
        rows.append(
            {
                "params": over,
                "isSharpe": is_m.get("sharpe"),
                "validationSharpe": val_m.get("sharpe"),
                "isTrades": is_m["trades"],
                "validationTrades": val_m["trades"],
                "validationCagr": val_m.get("cagr"),
                "validationMaxDrawdown": val_m.get("maxDrawdown"),
                "overfitWarning": bool(
                    is_m.get("sharpe") is not None
                    and is_m["sharpe"] > 0
                    and (val_m.get("sharpe") is None or val_m["sharpe"] < 0.5 * is_m["sharpe"])
                ),
            }
        )
    order = sorted(
        range(len(rows)),
        key=lambda i: (rows[i]["validationSharpe"] is None, -(rows[i]["validationSharpe"] or 0.0)),
    )
    rows = [rows[i] for i in order]
    stats = [stats[i] for i in order]
    for i, r in enumerate(rows):
        r["rank"] = i + 1
    best: dict[str, Any] | None = None
    if rows:
        h = _holdout(req, rows[0]["params"], split)
        holdout = {
            "sharpe": h.get("sharpe"),
            "trades": h["trades"],
            "cagr": h.get("cagr"),
            "maxDrawdown": h.get("maxDrawdown"),
        }
        best = {**rows[0], "holdout": holdout}
        stats[0]["oosPeriodSharpe"] = h.get("periodSharpe")
        stats[0]["oosSharpe"] = h.get("sharpe")
        stats[0]["oosTrades"] = h["trades"]
    return {
        "simulated": True,
        "disclaimer": DISCLAIMER,
        "rankedBy": "validation_sharpe",
        "selectionNote": SELECTION_NOTE,
        "method": req.method,
        "evaluated": len(combos),
        "cap": min(max_combos(), req.max_combos or max_combos()),
        "validationStart": vsplit,
        "oosStart": split,
        "results": rows[:100],
        "best": best,
        "trialStats": stats,
        "elapsedMs": round((time.perf_counter() - t0) * 1000, 1),
    }


def sensitivity(req: SensitivityRequest) -> dict[str, Any]:
    t0 = time.perf_counter()
    split = oos_start(req)
    vsplit = validation_start(req, split, req.validation_fraction)
    d = parse_definition(req.definition)
    for ax in (req.x, req.y):
        if ax.param not in d.params:
            raise ResearchError(f'Unknown parameter "{ax.param}" for the heatmap.')
    if req.x.param == req.y.param:
        raise ResearchError("Pick two different parameters for the heatmap.")
    _cap(len(req.x.values) * len(req.y.values), None)
    base = Params(d.params, req.param_overrides).values
    cells: list[list[dict[str, Any]]] = []
    stats: list[dict[str, Any]] = []
    for yv in req.y.values:
        row: list[dict[str, Any]] = []
        for xv in req.x.values:
            over = {req.x.param: xv, req.y.param: yv}
            try:
                is_m, val_m = _score(req, over, split, vsplit)
            except ResearchError as exc:
                row.append({"x": xv, "y": yv, "error": str(exc)})
                continue
            stats.append(_selection_stat({**base, **over}, is_m, val_m))
            row.append(
                {
                    "x": xv,
                    "y": yv,
                    "validationSharpe": val_m.get("sharpe"),
                    "isSharpe": is_m.get("sharpe"),
                    "validationTrades": val_m["trades"],
                }
            )
        cells.append(row)
    return {
        "simulated": True,
        "x": {"param": req.x.param, "values": req.x.values, "current": base[req.x.param]},
        "y": {"param": req.y.param, "values": req.y.values, "current": base[req.y.param]},
        "metric": "validation_sharpe",
        "cells": cells,
        "note": "Validation Sharpe (the end of the in-sample window; the out-of-sample holdout is "
        "not used). A flat plateau around the chosen cell suggests robustness; a lone bright cell "
        "is a lucky spike.",
        "trialStats": stats,
        "validationStart": vsplit,
        "oosStart": split,
        "elapsedMs": round((time.perf_counter() - t0) * 1000, 1),
    }


def _fold_bounds(
    n: int, mode: str, folds: int, train_fraction: float
) -> list[tuple[int, int, int, int]]:
    """(train_start, train_end, test_start, test_end) as timeline indices, end exclusive."""
    out: list[tuple[int, int, int, int]] = []
    if mode == "anchored":
        first = int(n * train_fraction)
        test_len = (n - first) // folds
        for k in range(folds):
            te = first + k * test_len
            out.append((0, te, te, n if k == folds - 1 else te + test_len))
    else:
        test_len = int(n * (1.0 - train_fraction) / folds)
        train_len = n - folds * test_len
        for k in range(folds):
            ts = k * test_len
            out.append(
                (
                    ts,
                    ts + train_len,
                    ts + train_len,
                    n if k == folds - 1 else ts + train_len + test_len,
                )
            )
    if any(b[3] - b[2] < 2 or b[1] - b[0] < 10 for b in out):
        raise ResearchError(
            "Too few bars for this many walk-forward folds. Use fewer folds or more data."
        )
    return out


def walk_forward(req: WalkForwardRequest) -> dict[str, Any]:
    t_start = time.perf_counter()
    d = parse_definition(req.definition)
    tl = timeline(req.data)
    if len(tl) < 40:
        raise ResearchError(f"Only {len(tl)} bars: walk-forward needs at least 40.")
    tf_ms = TIMEFRAME_SECONDS[d.universe.timeframe] * 1000
    bounds = _fold_bounds(len(tl), req.mode, req.folds, req.train_fraction)
    base = Params(d.params, req.param_overrides).values
    candidates: list[dict[str, float]] = [{}]
    if req.grid:
        for name in req.grid:
            if name not in d.params:
                raise ResearchError(f'Unknown parameter "{name}" in the grid.')
        candidates = _combos(req.grid)
        _cap(len(candidates) * req.folds, None)
    folds: list[dict[str, Any]] = []
    stats: dict[str, dict[str, Any]] = {}
    seg_ts: list[np.ndarray] = []
    seg_eq: list[np.ndarray] = []
    seg_mkt: list[np.ndarray] = []
    test_trades: list[Trade] = []
    fills: list[Any] = []
    swaps: list[tuple[int, float]] = []
    running = req.capital
    for k, (a, b, c, e) in enumerate(bounds):
        train_start, train_end, test_start = tl[a], tl[b - 1] + tf_ms, tl[c]
        test_end = tl[e - 1] + tf_ms
        best: tuple[float | None, dict[str, float], dict[str, Any]] | None = None
        for over in candidates:
            res = _run(req, over, end_ts=train_end, guard=True)
            m = segment_metrics(res, train_start if a > 0 else None, None)
            score = m.get("sharpe")
            key = repr(sorted({**base, **over}.items()))
            if key not in stats:
                stats[key] = _trial_stat(
                    {**base, **over}, m, {"periodSharpe": None, "sharpe": None, "trades": 0}
                )
            if best is None or (score is not None and (best[0] is None or score > best[0])):
                best = (score, over, m)
        if not (best is not None):  # pragma: no cover - type narrowing
            raise TypeError("unexpected DSL shape")
        res = _run(req, best[1], end_ts=test_end, guard=True)
        m_test = segment_metrics(res, test_start, None)
        lo = int(np.searchsorted(res.ts, test_start, side="right"))
        start_eq = float(res.equity[lo - 1]) if lo > 0 else res.capital
        eq_slice = res.equity[lo:]
        seg_ts.append(res.ts[lo:])
        seg_eq.append(eq_slice / start_eq * running if start_eq > 0 else eq_slice)
        seg_mkt.append(res.in_market[lo:])
        if len(eq_slice) and start_eq > 0:
            running = float(eq_slice[-1] / start_eq * running)
        test_trades += [t for t in res.trades if t.entry_ts >= test_start]
        fills += [f for f in res.fills if f.ts >= test_start]
        swaps += [s for s in res.swaps if s[0] > test_start]
        folds.append(
            {
                "fold": k + 1,
                "trainStart": train_start,
                "trainEnd": train_end,
                "testStart": test_start,
                "testEnd": test_end,
                "params": {**base, **best[1]},
                "isSharpe": best[2].get("sharpe"),
                "oosSharpe": m_test.get("sharpe"),
                "oosTrades": m_test["trades"],
                "oosNetPnl": m_test.get("netPnl"),
            }
        )
    ts = np.concatenate(seg_ts) if seg_ts else np.array([], dtype=np.int64)
    eq = np.concatenate(seg_eq) if seg_eq else np.array([])
    mkt = np.concatenate(seg_mkt) if seg_mkt else np.array([], dtype=bool)
    wf = compute_metrics(ts, eq, mkt, req.capital, test_trades, fills, swaps, None, None)
    n = len(ts)
    idx = (
        np.unique(np.linspace(0, n - 1, num=min(n, req.max_points)).astype(int))
        if n
        else np.array([], int)
    )
    return {
        "simulated": True,
        "disclaimer": DISCLAIMER,
        "mode": req.mode,
        "folds": folds,
        "metrics": wf,
        "equity": {"t": [int(x) for x in ts[idx]], "equity": [round(float(x), 2) for x in eq[idx]]},
        "trades": [_trade_wire(t, None) | {"segment": "wf"} for t in test_trades],
        "trialStats": list(stats.values()),
        "reoptimised": bool(req.grid),
        "elapsedMs": round((time.perf_counter() - t_start) * 1000, 1),
    }


def signal(req: SignalRequest) -> dict[str, Any]:
    """The live decision on the last bar of the window (same `decide` as the backtester)."""
    d = parse_definition(req.definition)
    try:
        p = Params(d.params, req.param_overrides)
        sym = to_input(req.data)
        if len(sym.bars) == 0:
            raise ResearchError("No bars to evaluate.")
        tf_s = TIMEFRAME_SECONDS[d.universe.timeframe]
        bpy = bars_per_year(tf_s)
        keys = feature_keys(d, p, req.ai_regime == "model")
        feats = compute_features(sym.bars, keys, bpy)
        verify_point_in_time(sym.bars, keys, bpy, feats, checkpoints=3)
        ctx = EvalContext(d, p, sym, feats, tf_s)
        t = len(sym.bars) - 1
        pos = None
        if req.position is not None:
            w = req.position
            pos = PositionState(
                side=1 if w.side == "long" else -1,
                qty=Decimal(w.qty),
                entry_ref=w.entry_ref,
                stop=w.stop,
                initial_stop=w.initial_stop,
                target=w.target,
                bars_held=w.bars_held,
                high_water=w.high_water,
            )
            c = float(sym.bars.c[t])
            pos.high_water = max(pos.high_water, c) if pos.side > 0 else min(pos.high_water, c)
        dx = decide(ctx, t, pos, req.equity, req.open_positions, bpy)
    except ValueError as exc:
        if exc.__class__ is not ValueError:
            raise
        raise ResearchError(str(exc)) from exc
    cm = sym.cost
    return {
        "simulated": True,
        "symbol": sym.symbol,
        "barTs": int(sym.bars.t[t]),
        "action": dx.action,
        "reason": dx.reason,
        "conditions": [e.to_wire() for e in dx.conditions],
        "qty": format(dx.qty.normalize(), "f") if dx.qty > 0 else None,
        "stopDistance": dx.stop_distance,
        "targetDistance": dx.target_distance,
        "newStop": None if dx.new_stop is None else fmt_price(dx.new_stop, cm),
        "highWater": None if pos is None else pos.high_water,
        "refClose": dx.ref_close,
        "features": {
            k: (None if math.isnan(float(v[t])) else round(float(v[t]), 10))
            for k, v in feats.items()
        },
        "params": p.values,
    }
