"""Statistical acceptance tests for the Monte Carlo engine (goal 05 acceptance criterion 1)."""

from __future__ import annotations

import json
import math
from typing import Any

import numpy as np
import pytest

from kora_quant.sim import edge, service
from kora_quant.sim.bootstrap import auto_block_size
from kora_quant.sim.models import FromTradesRequest, ProjectRequest


@pytest.fixture(autouse=True)
def _fresh_cache() -> None:
    service.clear_cache()


def _body(result: Any) -> dict[str, Any]:
    d: dict[str, Any] = json.loads(result.model_dump_json(by_alias=True))
    d.pop("elapsedMs")
    d.pop("cache")
    return d


# ---- 1. analytic mean at 50k paths, zero costs ---------------------------------------------


@pytest.mark.parametrize(
    ("win", "avg_win", "tail", "risk"),
    [(50.0, 1.5, 0.0, 1.0), (45.0, 1.8, 3.0, 1.0), (40.0, 2.0, 0.0, 2.0)],
)
def test_fixed_fractional_mean_matches_analytic_within_1pct(
    win: float, avg_win: float, tail: float, risk: float
) -> None:
    req = ProjectRequest(
        paths=50_000,
        seed=11,
        starting_capital=10_000,
        sizing_model="fixed_fractional",
        risk_pct=risk,
        win_rate_pct=win,
        avg_win_r=avg_win,
        cost_per_trade_r=0.0,
        fat_tail_prob_pct=tail,
        fat_tail_multiple=3.0,
        ruin_floor_pct=0.0,
        trades_per_period=20,
        horizon_periods=10,
    )
    r = service.project(req)
    p, q = win / 100, tail / 100
    exp_r = p * avg_win - (1 - p) * (1 + q * 2.0)
    analytic = 10_000 * (1 + risk / 100 * exp_r) ** req.trades_total
    assert r.final_equity.mean == pytest.approx(analytic, rel=0.01)
    # the whole mean band, period by period
    for k, m in enumerate(r.bands.mean):
        assert m == pytest.approx(10_000 * (1 + risk / 100 * exp_r) ** (20 * k), rel=0.01)
    assert r.expectancy_r == pytest.approx(exp_r)


def test_fixed_amount_mean_matches_analytic_within_1pct() -> None:
    req = ProjectRequest(
        paths=50_000,
        seed=3,
        sizing_model="fixed_amount",
        fixed_amount=50,
        win_rate_pct=50,
        avg_win_r=1.5,
        cost_per_trade_r=0,
        ruin_floor_pct=0,
        trades_per_period=20,
        horizon_periods=10,
    )
    r = service.project(req)
    assert r.final_equity.mean == pytest.approx(10_000 + 200 * 50 * 0.25, rel=0.01)


def test_withdrawals_come_out_of_the_mean() -> None:
    base: dict[str, Any] = {
        "paths": 20_000,
        "seed": 5,
        "sizing_model": "fixed_amount",
        "fixed_amount": 50,
        "win_rate_pct": 50,
        "avg_win_r": 1.5,
        "cost_per_trade_r": 0,
        "ruin_floor_pct": 0,
        "trades_per_period": 20,
        "horizon_periods": 10,
    }
    plain = service.project(ProjectRequest(**base))
    withdrawn = service.project(
        ProjectRequest(
            **base,
            withdrawals={"perPeriod": 100, "oneOff": [{"period": 5, "amount": 500}]},
        )
    )
    # Same seed and fixed amounts: every path is shifted by exactly the total withdrawn (1,500).
    assert plain.final_equity.mean - withdrawn.final_equity.mean == pytest.approx(1_500, abs=1e-6)
    assert withdrawn.risk_of_ruin_approx is None


def test_costs_lower_the_mean_by_the_analytic_amount() -> None:
    kw: dict[str, Any] = {
        "paths": 50_000,
        "seed": 9,
        "win_rate_pct": 45,
        "avg_win_r": 1.8,
        "ruin_floor_pct": 0,
        "trades_per_period": 20,
        "horizon_periods": 12,
    }
    r = service.project(ProjectRequest(**kw, cost_per_trade_r=0.08))
    exp_r = 0.45 * 1.8 - 0.55 - 0.08
    assert r.final_equity.mean == pytest.approx(10_000 * (1 + 0.01 * exp_r) ** 240, rel=0.01)


# ---- 2. risk of ruin vs closed form --------------------------------------------------------


@pytest.mark.parametrize(
    "case",
    [
        {"risk_pct": 2, "win_rate_pct": 40, "avg_win_r": 1.6, "ruin_floor_pct": 70,
         "trades_per_period": 20, "horizon_periods": 25},
        {"risk_pct": 3, "win_rate_pct": 45, "avg_win_r": 1.5, "cost_per_trade_r": 0.05,
         "ruin_floor_pct": 60, "trades_per_period": 25, "horizon_periods": 20},
        {"risk_pct": 1, "win_rate_pct": 50, "avg_win_r": 1.0, "cost_per_trade_r": 0.02,
         "ruin_floor_pct": 80, "trades_per_period": 50, "horizon_periods": 20},
        {"risk_pct": 5, "win_rate_pct": 35, "avg_win_r": 2.2, "cost_per_trade_r": 0.1,
         "ruin_floor_pct": 50, "trades_per_period": 10, "horizon_periods": 30,
         "fat_tail_prob_pct": 5},
        {"risk_pct": 2, "win_rate_pct": 50, "avg_win_r": 1.4, "cost_per_trade_r": 0.05,
         "ruin_floor_pct": 75, "trades_per_period": 20, "horizon_periods": 20},
    ],
)  # fmt: skip
def test_risk_of_ruin_matches_closed_form_fixed_fractional(case: dict[str, Any]) -> None:
    r = service.project(ProjectRequest(paths=50_000, seed=7, **case))
    assert r.risk_of_ruin_approx is not None
    assert abs(r.risk_of_ruin - r.risk_of_ruin_approx) < 0.02, (
        r.risk_of_ruin,
        r.risk_of_ruin_approx,
    )


def test_ruin_approx_edge_cases() -> None:
    coin = edge.trade_edge(0.5, 1.0, 0.0, 0.0, 1.0)
    assert edge.risk_of_ruin_fixed_fractional(coin, 0.01, 0.0, 100) == 0.0
    assert edge.risk_of_ruin_fixed_fractional(coin, 1.5, 0.5, 100) == 1.0  # one loss wipes out
    certain = edge.Edge(outcomes=np.array([-1.0]), probs=np.array([1.0]))
    assert edge.risk_of_ruin_fixed_fractional(certain, 0.1, 0.5, 100) == 1.0
    assert edge.risk_of_ruin_fixed_fractional(certain, 0.1, 0.5, 1) == 0.0


# ---- 3. seed determinism -------------------------------------------------------------------


def test_same_seed_gives_identical_output() -> None:
    req = ProjectRequest(seed=42, paths=5_000, fat_tail_prob_pct=3, stress_edge_cut_pct=25)
    a = _body(service.project(req))
    service.clear_cache()
    b = _body(service.project(req))
    assert a == b


def test_same_seed_identical_for_bootstrap_and_different_seed_differs() -> None:
    trades = [1.8, -1.0, -1.0, 2.2, -1.0, 0.5, -1.0, 1.9, -1.0, 3.0] * 5
    req = FromTradesRequest(trades=trades, seed=1, paths=2_000, horizon_periods=6)
    a = _body(service.from_trades(req))
    service.clear_cache()
    assert _body(service.from_trades(req)) == a
    c = _body(service.from_trades(req.model_copy(update={"seed": 2})))
    assert c["bands"] != a["bands"]


def test_results_are_cached_by_input_hash() -> None:
    req = ProjectRequest(paths=1_000)
    first = service.project(req)
    second = service.project(req)
    assert first.cache == "miss"
    assert second.cache == "hit"
    assert first.input_hash == second.input_hash
    third = service.project(req.model_copy(update={"seed": 2}))
    assert third.input_hash != first.input_hash


# ---- edge maths ----------------------------------------------------------------------------


@pytest.mark.parametrize(("p", "w"), [(0.45, 1.8), (0.55, 1.0), (0.3, 3.0)])
def test_full_kelly_matches_binary_closed_form(p: float, w: float) -> None:
    full = edge.full_kelly(edge.trade_edge(p, w, 0.0, 0.0, 1.0))
    assert full == pytest.approx(p - (1 - p) / w, abs=1e-9)


def test_full_kelly_with_costs_matches_closed_form() -> None:
    p, w, c = 0.45, 1.8, 0.08
    expected = (p * (w - c) - (1 - p) * (1 + c)) / ((w - c) * (1 + c))
    assert edge.full_kelly(edge.trade_edge(p, w, c, 0.0, 1.0)) == pytest.approx(expected, abs=1e-9)


def test_full_kelly_zero_without_edge_and_capped_by_worst_case() -> None:
    assert edge.full_kelly(edge.trade_edge(0.4, 1.0, 0.0, 0.0, 1.0)) == 0.0
    always_win = edge.Edge(outcomes=np.array([1.0, 2.0]), probs=np.array([0.5, 0.5]))
    assert math.isinf(edge.full_kelly(always_win))
    lopsided = edge.Edge(outcomes=np.array([100.0, -1.0]), probs=np.array([0.99, 0.01]))
    assert edge.full_kelly(lopsided) == pytest.approx(0.99 - 0.01 / 100, abs=1e-9)


def test_stress_cuts_gross_edge_by_the_requested_fraction() -> None:
    loss = edge.avg_loss_r(0.03, 3.0)
    e0 = edge.gross_expectancy(0.45, 1.8, loss)
    p2 = edge.stressed_win_rate(0.45, 1.8, loss, 0.5)
    assert edge.gross_expectancy(p2, 1.8, loss) == pytest.approx(0.5 * e0)
    assert edge.stressed_win_rate(0.3, 1.0, 1.0, 0.5) == 0.3  # no edge, nothing to cut
    assert edge.stressed_win_rate(0.45, 1.8, loss, 0.0) == 0.45


def test_stress_toggle_lowers_the_median() -> None:
    base = ProjectRequest(paths=10_000, fat_tail_prob_pct=3)
    plain = service.project(base)
    stressed = service.project(base.model_copy(update={"stress_edge_cut_pct": 50.0}))
    assert stressed.final_equity.p50 < plain.final_equity.p50
    assert stressed.effective.win_rate_pct < plain.effective.win_rate_pct


def test_kelly_fraction_sizing_uses_full_kelly() -> None:
    r = service.project(
        ProjectRequest(paths=500, sizing_model="kelly_fraction", kelly_fraction=0.5)
    )
    assert r.kelly.ratio == pytest.approx(0.5)
    assert r.kelly.user_fraction == pytest.approx(0.5 * r.kelly.full)


# ---- bootstrap -----------------------------------------------------------------------------


@pytest.mark.parametrize(("n", "b"), [(1, 1), (8, 2), (27, 3), (28, 4), (100, 5), (1000, 10)])
def test_auto_block_size(n: int, b: int) -> None:
    assert auto_block_size(n) == b


def test_auto_block_size_rejects_empty() -> None:
    with pytest.raises(ValueError, match="at least one"):
        auto_block_size(0)


def test_bootstrap_mean_matches_resampled_mean() -> None:
    rng = np.random.default_rng(0)
    trades = list(np.round(rng.choice([2.0, -1.0], size=300, p=[0.4, 0.6]), 4))
    mean_r = float(np.mean(trades))
    req = FromTradesRequest(
        trades=trades,
        paths=50_000,
        seed=4,
        risk_pct=1,
        ruin_floor_pct=0,
        trades_per_period=20,
        horizon_periods=10,
        block_size=5,
    )
    r = service.from_trades(req)
    assert r.final_equity.mean == pytest.approx(10_000 * (1 + 0.01 * mean_r) ** 200, rel=0.01)
    assert r.effective.block_size == 5
    assert r.expectancy_unit == "r"


def test_bootstrap_pct_returns_and_auto_block() -> None:
    trades = [0.8, -0.5, -0.4, 1.1, -0.5, 0.2, 0.9, -0.6] * 10
    r = service.from_trades(
        FromTradesRequest(trades=trades, trade_unit="pct_return", paths=1_000, source="paper")
    )
    assert r.expectancy_unit == "pct"
    assert r.effective.block_size == auto_block_size(80)
    assert r.expectancy_r == pytest.approx(float(np.mean(trades)))
    assert r.effective.risk_fraction is None
    assert {c.code for c in r.reality_checks} == {"small_sample"}


def test_block_bootstrap_keeps_streaks_that_iid_breaks() -> None:
    # Losses clustered in runs of 10: a block of 10 reproduces long streaks; blocks of 1 cannot.
    trades = ([-1.0] * 10 + [1.5] * 10) * 10
    common: dict[str, Any] = {"trades": trades, "paths": 2_000, "horizon_periods": 5}
    blocky = service.from_trades(FromTradesRequest(block_size=10, **common))
    iid = service.from_trades(FromTradesRequest(block_size=1, **common))
    assert blocky.longest_losing_streak.median > iid.longest_losing_streak.median + 3


# ---- output shape --------------------------------------------------------------------------


def test_output_shape_and_ordering() -> None:
    r = service.project(ProjectRequest(paths=2_000, horizon_periods=12))
    assert len(r.bands.p50) == 13
    assert r.bands.p5[0] == r.bands.p95[0] == 10_000
    for lo, mid, hi in zip(r.bands.p5, r.bands.p50, r.bands.p95, strict=True):
        assert lo <= mid <= hi
    assert len(r.sample_paths) == 3
    assert all(len(p) == 13 for p in r.sample_paths)
    assert sum(r.max_drawdown.histogram.counts) == 2_000
    assert sum(r.final_equity.histogram.counts) == 2_000
    assert r.max_drawdown.histogram.edges[-1] == 1.0
    assert 0 <= r.prob_end_below_start <= 1
    assert r.simulated is True
    assert "SIMULATED" in r.disclaimer
