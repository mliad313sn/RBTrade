"""Orchestrates a run: edge maths → engine → summaries → reality checks, with result caching."""

from __future__ import annotations

import math

import numpy as np

from . import edge
from .bootstrap import auto_block_size
from .cache import LruCache, input_hash
from .engine import (
    MODE_AMOUNT,
    MODE_FRACTION,
    PathSpec,
    bootstrap_chunks,
    parametric_chunks,
    run_paths,
    summarise,
    withdrawal_schedule,
)
from .models import (
    Effective,
    FromTradesRequest,
    Kelly,
    ProjectRequest,
    RealityCheckRequest,
    RealityCheckResponse,
    RunShape,
    SimResult,
)
from .reality import CheckInput, evaluate

DISCLAIMER = (
    "SIMULATED. A projection assumes the edge stays constant, which real markets rarely allow. "
    "It is not a forecast and not investment advice."
)

_cache: LruCache[SimResult] = LruCache(128)


def clear_cache() -> None:
    _cache.clear()


def _schedule(req: RunShape) -> np.ndarray:
    return withdrawal_schedule(
        req.horizon_periods,
        req.withdrawals.per_period,
        [(w.period, w.amount) for w in req.withdrawals.one_off],
    )


def _has_withdrawals(req: RunShape) -> bool:
    return req.withdrawals.per_period > 0 or any(w.amount > 0 for w in req.withdrawals.one_off)


def _cached(kind: str, req: RunShape) -> tuple[str, SimResult | None]:
    key = input_hash(kind, req.model_dump_json(by_alias=True))
    hit = _cache.get(key)
    return key, (hit.model_copy(update={"cache": "hit"}) if hit is not None else None)


def project(req: ProjectRequest) -> SimResult:
    key, hit = _cached("project", req)
    if hit is not None:
        return hit
    p = req.win_rate_pct / 100.0
    q = req.fat_tail_prob_pct / 100.0
    loss = edge.avg_loss_r(q, req.fat_tail_multiple)
    p_eff = edge.stressed_win_rate(p, req.avg_win_r, loss, req.stress_edge_cut_pct / 100.0)
    net = edge.trade_edge(p_eff, req.avg_win_r, req.cost_per_trade_r, q, req.fat_tail_multiple)
    full = edge.full_kelly(net)

    if req.sizing_model == "fixed_amount":
        mode, size = MODE_AMOUNT, req.fixed_amount
        user_fraction = req.fixed_amount / req.starting_capital
    else:
        mode = MODE_FRACTION
        size = (
            req.risk_pct / 100.0
            if req.sizing_model == "fixed_fractional"
            else req.kelly_fraction * full
        )
        user_fraction = size

    floor_frac = req.ruin_floor_pct / 100.0
    spec = PathSpec(
        paths=req.paths,
        trades=req.trades_total,
        trades_per_period=req.trades_per_period,
        start=req.starting_capital,
        floor=req.starting_capital * floor_frac,
        mode=mode,
        size=size,
        withdrawals=_schedule(req),
    )
    raw = run_paths(
        spec,
        req.seed,
        parametric_chunks(
            req.trades_total, p_eff, req.avg_win_r, req.cost_per_trade_r, q, req.fat_tail_multiple
        ),
    )
    approx = None
    if mode == MODE_FRACTION and not _has_withdrawals(req) and size > 0:
        approx = edge.risk_of_ruin_fixed_fractional(net, size, floor_frac, req.trades_total)

    checks = evaluate(
        CheckInput(
            win_rate=p,
            avg_win_r=req.avg_win_r / loss,
            expectancy_after_costs_r=net.mean,
            risk_fraction=user_fraction,
            full_kelly=full,
        )
    )
    s = summarise(raw, req.starting_capital)
    result = SimResult(
        kind="project",
        input_hash=key,
        cache="miss",
        seed=req.seed,
        paths=req.paths,
        trades_per_path=req.trades_total,
        periods=req.horizon_periods,
        starting_capital=req.starting_capital,
        ruin_floor=spec.floor,
        bands=s.bands,
        sample_paths=s.sample_paths,
        final_equity=s.final_equity,
        prob_end_below_start=s.prob_end_below_start,
        risk_of_ruin=s.risk_of_ruin,
        risk_of_ruin_approx=approx,
        max_drawdown=s.max_drawdown,
        time_under_water=s.time_under_water,
        longest_losing_streak=s.longest_losing_streak,
        expectancy_r=net.mean,
        expectancy_gross_r=edge.gross_expectancy(p_eff, req.avg_win_r, loss),
        expectancy_unit="r",
        kelly=Kelly(
            full=full if math.isfinite(full) else None,
            user_fraction=user_fraction,
            ratio=(user_fraction / full) if 0 < full < math.inf else None,
        ),
        effective=Effective(
            win_rate_pct=p_eff * 100.0,
            avg_win_r=req.avg_win_r,
            avg_loss_r=loss,
            cost_per_trade_r=req.cost_per_trade_r,
            risk_fraction=user_fraction,
        ),
        reality_checks=checks,
        elapsed_ms=raw.elapsed_ms,
        disclaimer=DISCLAIMER,
    )
    _cache.put(key, result)
    return result


def from_trades(req: FromTradesRequest) -> SimResult:
    key, hit = _cached("from_trades", req)
    if hit is not None:
        return hit
    arr = np.asarray(req.trades, dtype=np.float64)
    if req.trade_unit == "r_multiple":
        outcomes = arr - req.extra_cost_per_trade_r
        fraction = req.risk_pct / 100.0
        unit = "r"
        scale = 1.0
    else:
        outcomes = arr / 100.0
        fraction = 1.0  # returns are already the equity change as traded
        unit = "pct"
        scale = 100.0
    block = req.block_size or auto_block_size(len(outcomes))
    empirical = edge.empirical_edge(outcomes)
    full = edge.full_kelly(empirical)
    floor_frac = req.ruin_floor_pct / 100.0
    spec = PathSpec(
        paths=req.paths,
        trades=req.trades_total,
        trades_per_period=req.trades_per_period,
        start=req.starting_capital,
        floor=req.starting_capital * floor_frac,
        mode=MODE_FRACTION,
        size=fraction,
        withdrawals=_schedule(req),
    )
    raw = run_paths(spec, req.seed, bootstrap_chunks(outcomes, req.trades_total, block))
    approx = None
    if not _has_withdrawals(req):
        approx = edge.risk_of_ruin_fixed_fractional(
            empirical, fraction, floor_frac, req.trades_total
        )

    wins = outcomes[outcomes > 0]
    losses = outcomes[outcomes < 0]
    win_rate = len(wins) / len(outcomes)
    avg_win = float(wins.mean()) if len(wins) else 0.0
    avg_loss = float(-losses.mean()) if len(losses) else 0.0
    ratio = avg_win / avg_loss if avg_loss > 0 else float(len(wins) > 0) * 1e9
    checks = evaluate(
        CheckInput(
            win_rate=win_rate,
            avg_win_r=ratio,
            expectancy_after_costs_r=empirical.mean,
            risk_fraction=fraction if req.trade_unit == "r_multiple" else None,
            full_kelly=full,
            imported_trades=len(outcomes),
            source=req.source,
        )
    )
    s = summarise(raw, req.starting_capital)
    gross = float(arr.mean()) / scale if req.trade_unit == "pct_return" else float(arr.mean())
    result = SimResult(
        kind="from_trades",
        input_hash=key,
        cache="miss",
        seed=req.seed,
        paths=req.paths,
        trades_per_path=req.trades_total,
        periods=req.horizon_periods,
        starting_capital=req.starting_capital,
        ruin_floor=spec.floor,
        bands=s.bands,
        sample_paths=s.sample_paths,
        final_equity=s.final_equity,
        prob_end_below_start=s.prob_end_below_start,
        risk_of_ruin=s.risk_of_ruin,
        risk_of_ruin_approx=approx,
        max_drawdown=s.max_drawdown,
        time_under_water=s.time_under_water,
        longest_losing_streak=s.longest_losing_streak,
        expectancy_r=empirical.mean * scale,
        expectancy_gross_r=gross * scale,
        expectancy_unit=unit,
        kelly=Kelly(
            full=full if math.isfinite(full) else None,
            user_fraction=fraction,
            ratio=(fraction / full) if 0 < full < math.inf else None,
        ),
        effective=Effective(
            win_rate_pct=win_rate * 100.0,
            avg_win_r=avg_win * scale,
            avg_loss_r=avg_loss * scale,
            cost_per_trade_r=req.extra_cost_per_trade_r,
            risk_fraction=fraction if req.trade_unit == "r_multiple" else None,
            block_size=block,
        ),
        reality_checks=checks,
        elapsed_ms=raw.elapsed_ms,
        disclaimer=DISCLAIMER,
    )
    _cache.put(key, result)
    return result


def reality_checks(req: RealityCheckRequest) -> RealityCheckResponse:
    q = req.fat_tail_prob_pct / 100.0
    loss = edge.avg_loss_r(q, req.fat_tail_multiple)
    net = edge.trade_edge(
        req.win_rate_pct / 100.0, req.avg_win_r, req.cost_per_trade_r, q, req.fat_tail_multiple
    )
    return RealityCheckResponse(
        checks=evaluate(
            CheckInput(
                win_rate=req.win_rate_pct / 100.0,
                avg_win_r=req.avg_win_r / loss,
                expectancy_after_costs_r=net.mean,
                risk_fraction=None if req.risk_pct is None else req.risk_pct / 100.0,
                full_kelly=edge.full_kelly(net),
                imported_trades=req.imported_trades,
                source=req.source,
            )
        )
    )
