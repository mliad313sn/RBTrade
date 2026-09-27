"""IRTC R3-06: annualisation follows the venue session calendar the api sends per instrument.

A weekday-only daily series has ~252 bars a year, a 7-hour equity session ~1,764 one-hour bars;
assuming 24/7 (365 x 24 / tf) overstated realised volatility by sqrt(365/252) and x2.2 and sized
volatility-target positions too small. SIMULATED data only."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from bt_helpers import SYN_COSTS, ema_cross_definition
from kora_quant.bt.models import BacktestRunRequest, SignalRequest
from kora_quant.bt.research import backtest, signal

DAY_MS = 86_400_000
T0 = 1_767_571_200_000  # Monday 2026-01-05


def _weekday_series(n: int, annual_vol: float, seed: int) -> dict[str, Any]:
    """Daily bars on weekdays only, with a true annual volatility over 252 trading days."""
    rng = np.random.default_rng(seed)
    ts: list[int] = []
    d = 0
    while len(ts) < n:
        t = T0 + d * DAY_MS
        if d % 7 < 5:  # T0 is a Monday: Mon..Fri
            ts.append(t)
        d += 1
    r = rng.standard_normal(n) * annual_vol / math.sqrt(252)
    c = 100 * np.exp(np.cumsum(r))
    o = np.r_[100, c[:-1]]
    return {
        "t": ts,
        "o": [round(float(x), 4) for x in o],
        "h": [round(float(x), 4) for x in np.maximum(o, c) * 1.001],
        "l": [round(float(x), 4) for x in np.minimum(o, c) * 0.999],
        "c": [round(float(x), 4) for x in c],
        "v": [1.0] * n,
    }


def _vol_target_definition() -> dict[str, Any]:
    d = ema_cross_definition()
    d["universe"]["timeframe"] = "1D"
    d["size"] = {"kind": "vol_target", "annualVolPct": 10, "lookback": 60, "maxOpenPositions": 1}
    return d


def test_signal_realised_vol_uses_the_calendar_bars_per_year() -> None:
    vols = []
    for seed in range(8):
        bars = _weekday_series(700, 0.20, seed)
        out = signal(
            SignalRequest.model_validate(
                {
                    "definition": _vol_target_definition(),
                    "data": {
                        "symbol": "SYN",
                        "bars": bars,
                        "costs": SYN_COSTS,
                        "barsPerYear": 252.0,
                    },
                    "equity": 100_000.0,
                }
            )
        )
        vols.append(out["features"]["realised_vol:60"])
    # True vol 20 %: the 60-bar estimate averages close to it (24/7 annualisation gave ~23.9 %).
    assert abs(float(np.mean(vols)) - 20.0) < 1.5, vols


def test_backtest_uses_each_instruments_own_bars_per_year() -> None:
    bars = _weekday_series(500, 0.20, 3)
    base = {
        "definition": _vol_target_definition(),
        "capital": 100_000.0,
        "guard": True,
    }
    cal = backtest(
        BacktestRunRequest.model_validate(
            {
                **base,
                "data": [{"symbol": "SYN", "bars": bars, "costs": SYN_COSTS, "barsPerYear": 252.0}],
            }
        )
    )
    cont = backtest(
        BacktestRunRequest.model_validate(
            {**base, "data": [{"symbol": "SYN", "bars": bars, "costs": SYN_COSTS}]}
        )
    )
    q_cal = [float(t["qty"]) for t in cal["trades"]]
    q_cont = [float(t["qty"]) for t in cont["trades"]]
    assert q_cal and len(q_cal) == len(q_cont)
    # Lower (correct) vol => larger vol-target positions, by about sqrt(365/252).
    ratio = float(np.median(np.array(q_cal) / np.array(q_cont)))
    assert abs(ratio - math.sqrt(365 / 252)) < 0.05, ratio
