"""Metrics on hand series and the cost model's golden vectors (shared with the TypeScript
domain)."""

from __future__ import annotations

from decimal import Decimal

import numpy as np
import pytest

from kora_quant.bt.costs import (
    CostModel,
    commission,
    quote,
    round_tick,
    snap_qty,
    swap,
    taker_price,
)
from kora_quant.bt.engine import DAY_MS, Fill, Trade
from kora_quant.bt.metrics import compute_metrics, daily_returns, max_drawdown

D0 = 1_767_571_200_000


def cm(**kw: object) -> CostModel:
    base: dict[str, object] = {
        "tickSize": 0.01,
        "pricePrecision": 2,
        "qtyStep": "0.01",
        "minQty": "0.01",
    }
    return CostModel.model_validate({**base, **kw})


def test_commission_golden_vectors_match_the_domain_formula() -> None:
    # Same vectors as packages/domain trading tests: bps of notional, per unit with minimum,
    # half-even.
    fx = cm(commissionBps=0.2)
    assert commission(100_000, 1.08421, fx) == 2.17  # 21,684.2 × 0.2 bp = 2.16842 → 2.17
    eq = cm(commissionPerUnit=0.005, commissionMin=1.0)
    assert commission(100, 221.38, eq) == 1.0  # 0.50 → minimum 1.00
    assert commission(1000, 221.38, eq) == 5.0
    crypto = cm(commissionBps=10)
    assert commission(0.8, 64813.5, crypto) == 51.85  # 51.8508
    half = cm(commissionPerUnit=0.005)
    assert commission(1, 1.0, half) == 0.0  # 0.005 → half-even → 0.00
    assert commission(3, 1.0, half) == 0.02  # 0.015 → half-even → 0.02
    fut = cm(commissionPerUnit=1.5, multiplier=50.0)
    assert commission(2, 5000.0, fut) == 3.0


def test_quote_taker_and_rounding() -> None:
    c = cm(spreadTicks=3.0, volFactor=0.1)
    bid, ask = quote(100.0, c)
    assert bid == pytest.approx(99.98)
    assert ask == pytest.approx(100.02)
    assert taker_price("buy", 100.0, 0.5, c) == pytest.approx(100.07)  # ask 100.02 + ceil(0.05)
    assert taker_price("sell", 100.0, -0.5, c) == pytest.approx(99.93)
    assert round_tick(1.005, 0.01, "nearest") == pytest.approx(1.01)
    assert round_tick(1.0049999, 0.01, "up") == pytest.approx(1.01)
    assert round_tick(1.0100000001, 0.01, "up") == pytest.approx(1.01)
    assert snap_qty(1.239, c) == Decimal("1.23")
    assert snap_qty(0.0, c) == Decimal(0)
    assert snap_qty(float("inf"), c) == Decimal(0)
    s = cm(swapLongBps=-360.0, swapShortBps=-180.0)
    assert swap(1, 100.0, s, 1) == pytest.approx(-0.01)
    assert swap(-2, 100.0, s, 2) == pytest.approx(-0.02)
    assert swap(0, 100.0, s, 3) == 0.0


def _trade(net: float, r: float, ts: int) -> Trade:
    return Trade(
        "X", "long", "1", ts, "1", ts, "1", "stop", "1", None, net, 0.0, 0.0, net, r, 1, {}
    )


def test_metrics_on_a_hand_series() -> None:
    ts = np.array(
        [D0 + (i + 1) * DAY_MS for i in range(4)], dtype=np.int64
    )  # daily closes at midnight
    eq = np.array([110.0, 99.0, 99.0, 121.0])
    r = daily_returns(ts, eq, 100.0)
    assert r.tolist() == pytest.approx([0.1, -0.1, 0.0, 22 / 99])
    mdd, days = max_drawdown(ts, eq, 100.0)
    assert mdd == pytest.approx(-0.1)
    assert days == pytest.approx(3.0)  # peak on day 1, recovered on day 4
    trades = [
        _trade(10, 1.0, int(ts[0])),
        _trade(-5, -0.5, int(ts[1])),
        _trade(20, 2.0, int(ts[2])),
    ]
    fills = [Fill(int(ts[0]), "X", "buy", Decimal(1), 100.0, 1000.0, 1.0, 0.5, "entry")]
    m = compute_metrics(
        ts,
        eq,
        np.array([True, True, False, False]),
        100.0,
        trades,
        fills,
        [(int(ts[1]), -0.5)],
        None,
        None,
    )
    assert m["trades"] == 3
    assert m["winRate"] == pytest.approx(2 / 3, abs=1e-4)
    assert m["profitFactor"] == pytest.approx(6.0)
    assert m["expectancyR"] == pytest.approx(0.8333, abs=1e-4)
    assert m["expectancyCcy"] == pytest.approx(8.33)
    assert m["exposurePct"] == 50.0
    assert m["maxDrawdown"] == pytest.approx(-0.1)
    assert m["netPnl"] == 21.0
    mean = float(np.mean(r))
    sd = float(np.std(r, ddof=1))
    assert m["periodSharpe"] == pytest.approx(mean / sd, abs=1e-6)
    assert m["sharpe"] == pytest.approx(mean / sd * np.sqrt(m["annualisation"]), abs=1e-3)
    assert m["costDragPct"] is not None and m["costDragPct"] > 0
    assert m["turnover"] is not None and m["turnover"] > 0
    # A 4-day segment: CAGR and Calmar are not extrapolated to a year (IRTC R3-15).
    assert m["cagr"] is None and m["calmar"] is None


def test_no_drawdown_duration_on_new_highs_and_no_cagr_on_tiny_segments() -> None:
    """IRTC R3-15: a curve that only makes new highs has no drawdown duration (was 1 day), and a
    one-day +1 % segment has no CAGR (was 3,688 %)."""
    ts = np.array([D0 + (i + 1) * DAY_MS for i in range(366)], dtype=np.int64)
    eq = 1e5 * 1.001 ** np.arange(1, 367)
    m = compute_metrics(ts, eq, np.ones(366, bool), 1e5, [], [], [], None, None)
    assert m["maxDrawdown"] == 0.0 and m["maxDrawdownDays"] == 0.0
    assert m["cagr"] == pytest.approx(1.001**365.25 - 1, rel=1e-4)
    one = compute_metrics(
        np.array([D0 + DAY_MS], dtype=np.int64),
        np.array([1.01e5]),
        np.ones(1, bool),
        1e5,
        [],
        [],
        [],
        None,
        None,
    )
    assert one["cagr"] is None and one["calmar"] is None


def test_metrics_edge_cases() -> None:
    empty = compute_metrics(
        np.array([], dtype=np.int64),
        np.array([]),
        np.array([], dtype=bool),
        100.0,
        [],
        [],
        [],
        None,
        None,
    )
    assert empty["sharpe"] is None and empty["trades"] == 0
    ts = np.array([D0 + DAY_MS], dtype=np.int64)
    flat = compute_metrics(ts, np.array([100.0]), np.array([False]), 100.0, [], [], [], None, None)
    assert flat["sharpe"] is None and flat["maxDrawdown"] == 0.0 and flat["winRate"] is None
    assert max_drawdown(np.array([], dtype=np.int64), np.array([]), 1.0) == (0.0, 0.0)
