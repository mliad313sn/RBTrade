"""Acceptance: the look-ahead guard fails the run when future data is injected into a feature."""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bt_helpers import bars_wire, syn_request, synthetic_series, toy_request
from kora_quant.app import create_app
from kora_quant.bt import indicators as ind
from kora_quant.bt.evaluate import LookAheadError, compute_features, verify_point_in_time
from kora_quant.bt.models import BacktestRunRequest
from kora_quant.bt.research import backtest
from kora_quant.config import Settings


def _leaky_highest(b: ind.Bars, n: int, _y: float) -> ind.F:
    """Injects future data: the 'highest' of the NEXT n bars (includes bars after t)."""
    out = np.full(len(b), np.nan)
    for i in range(len(b) - 1):
        out[i] = float(np.max(b.h[i + 1 : i + 1 + n]))
    return out


@pytest.fixture
def leaky() -> Iterator[None]:
    original = ind.REGISTRY["highest"]
    ind.REGISTRY["highest"] = _leaky_highest
    try:
        yield
    finally:
        ind.REGISTRY["highest"] = original


@pytest.mark.usefixtures("leaky")
def test_injected_future_data_fails_the_backtest() -> None:
    with pytest.raises(LookAheadError, match="Look-ahead detected: feature highest:3"):
        backtest(BacktestRunRequest.model_validate(toy_request()))


@pytest.mark.usefixtures("leaky")
def test_guard_failure_is_a_plain_422_over_http() -> None:
    with TestClient(create_app(Settings(env="test", live_trading_enabled=False, port=0))) as c:
        res = c.post("/bt/run", json=toy_request())
    assert res.status_code == 422
    detail = res.json()["detail"][0]
    assert detail["type"] == "look_ahead"
    assert "used future data" in detail["msg"]


def test_without_the_leak_the_same_run_passes() -> None:
    out = backtest(BacktestRunRequest.model_validate(toy_request()))
    assert out["guard"]["passed"] is True


def test_perturbing_future_bars_never_changes_past_decisions() -> None:
    """Point-in-time property: trades that closed before bar k are identical whatever follows k."""
    rows = synthetic_series(900)
    base = backtest(BacktestRunRequest.model_validate(syn_request(900)))
    cut = 600
    shocked = [*rows[:cut], *[(o * 1.3, h * 1.3, lo * 1.3, c * 1.3) for o, h, lo, c in rows[cut:]]]
    req = syn_request(900)
    req["data"][0]["bars"] = bars_wire(shocked)
    other = backtest(BacktestRunRequest.model_validate(req))
    t_cut = req["data"][0]["bars"]["t"][cut]
    before_a = [t for t in base["trades"] if t["exitTs"] < t_cut]
    before_b = [t for t in other["trades"] if t["exitTs"] < t_cut]
    assert before_a, "the series must trade before the cut"
    assert before_a == before_b


def _pivot_flag(b: ind.Bars, _n: int, _y: float) -> ind.F:
    """IRTC R3-05: a classic sparse leak (a centred 21-bar pivot-high flag, as in zigzag/fractal
    indicators): 1 only on bars that are the highest of the 10 bars on each side."""
    hh, k = b.h, 10
    out = np.zeros(len(hh))
    for i in range(len(hh)):
        lo, hi = max(0, i - k), min(len(hh), i + k + 1)
        out[i] = 1.0 if hh[i] == hh[lo:hi].max() and i + k < len(hh) else 0.0
    return out


def test_guard_catches_a_sparse_leak_in_almost_every_series() -> None:
    """Before the fix the guard compared one row at 8 evenly spaced checkpoints and passed this
    leak in 17 of 40 random series."""
    original = ind.REGISTRY["volume"]
    ind.REGISTRY["volume"] = _pivot_flag
    passed = 0
    try:
        for s in range(40):
            r = np.random.default_rng(100 + s)
            n = 2000
            c = 100 * np.exp(np.cumsum(r.normal(0, 0.01, n)))
            o = np.r_[100, c[:-1]]
            bars = ind.Bars(
                np.arange(n, dtype=np.int64) * 3_600_000,
                o,
                np.maximum(o, c) * 1.001,
                np.minimum(o, c) * 0.999,
                c,
                np.ones(n),
            )
            feats = compute_features(bars, ["volume"], 8760.0)
            try:
                verify_point_in_time(bars, ["volume"], 8760.0, feats)
                passed += 1
            except LookAheadError:
                pass
    finally:
        ind.REGISTRY["volume"] = original
    assert passed <= 1, passed


def _faint_leak(b: ind.Bars, _n: int, _y: float) -> ind.F:
    """IRTC R6 (mutant LA-2): a leak too small to see by eye. Each value moves by one millionth of
    the next bar's return, and the last bar (whose future is unknown) has no move. Values stay
    finite everywhere, so only the comparison tolerance can catch it."""
    c = b.c.astype(np.float64)
    nxt = np.r_[c[1:], c[-1]]
    out: ind.F = c * (1.0 + 1e-6 * (nxt / c - 1.0))
    return out


def test_guard_tolerance_catches_a_faint_finite_leak() -> None:
    original = ind.REGISTRY["volume"]
    ind.REGISTRY["volume"] = _faint_leak
    try:
        r = np.random.default_rng(7)
        n = 600
        c = 100 * np.exp(np.cumsum(r.normal(0, 0.01, n)))
        o = np.r_[100, c[:-1]]
        bars = ind.Bars(
            np.arange(n, dtype=np.int64) * 3_600_000,
            o,
            np.maximum(o, c) * 1.001,
            np.minimum(o, c) * 0.999,
            c,
            np.ones(n),
        )
        feats = compute_features(bars, ["volume"], 8760.0)
        assert np.isfinite(feats["volume"]).all()
        with pytest.raises(LookAheadError, match="feature volume"):
            verify_point_in_time(bars, ["volume"], 8760.0, feats)
    finally:
        ind.REGISTRY["volume"] = original
