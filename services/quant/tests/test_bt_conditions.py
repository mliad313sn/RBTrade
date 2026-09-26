"""Session, venue, event and AI-regime conditions; portfolio limits; sizing models; funding."""

from __future__ import annotations

import copy
from typing import Any

from bt_helpers import (
    HOUR_MS,
    SYN_COSTS,
    T0,
    TOY_BARS,
    TOY_COSTS,
    bars_wire,
    ema_cross_definition,
    synthetic_series,
    toy_request,
)
from kora_quant.bt.models import BacktestRunRequest, SignalRequest
from kora_quant.bt.research import backtest, signal


def _with_filter(cond: dict[str, Any], **data_extra: Any) -> dict[str, Any]:
    req = toy_request()
    req["definition"] = copy.deepcopy(req["definition"])
    req["definition"]["filters"] = [cond]
    req["data"][0].update(data_extra)
    return req


def _entries(req: dict[str, Any]) -> list[int]:
    return [t["entryTs"] for t in backtest(BacktestRunRequest.model_validate(req))["trades"]]


def test_session_window_in_the_venue_time_zone() -> None:
    # Bars close at 01:00…14:00 UTC on a Monday; Tokyo is UTC+9 → 10:00…23:00 local.
    inside = _entries(
        _with_filter(
            {"type": "session_window", "timezone": "Asia/Tokyo", "start": "09:00", "end": "23:59"}
        )
    )
    assert len(inside) == 4
    none = _entries(
        _with_filter(
            {"type": "session_window", "timezone": "UTC", "start": "20:00", "end": "21:00"}
        )
    )
    assert none == []
    overnight = _entries(
        _with_filter(
            {"type": "session_window", "timezone": "UTC", "start": "23:00", "end": "05:00"}
        )
    )
    assert overnight == [T0 + 4 * HOUR_MS]  # decision on the 04:00 close only
    weekend_only = _entries(
        _with_filter(
            {
                "type": "session_window",
                "timezone": "UTC",
                "start": "00:00",
                "end": "23:59",
                "days": [6, 7],
            }
        )
    )
    assert weekend_only == []


def test_venue_open_uses_registry_session_flags_and_is_unavailable_without_them() -> None:
    flags = [True] * len(TOY_BARS)
    flags[3] = False
    req = _with_filter({"type": "venue_open"}, sessionOpen=flags)
    assert T0 + 4 * HOUR_MS not in _entries(req)
    assert _entries(_with_filter({"type": "venue_open"})) == []  # not available → never enters


def test_no_event_window_and_missing_calendar() -> None:
    close3 = T0 + 4 * HOUR_MS  # decision bar 3 closes at 04:00
    req = _with_filter(
        {"type": "no_event", "withinMinutes": 30, "impact": "high"}, events=[close3 + 10 * 60_000]
    )
    assert T0 + 4 * HOUR_MS not in _entries(req)
    far = _with_filter(
        {"type": "no_event", "withinMinutes": 30, "impact": "high"},
        events=[close3 + 5 * HOUR_MS * 10],
    )
    assert T0 + 4 * HOUR_MS in _entries(far)
    assert _entries(_with_filter({"type": "no_event", "withinMinutes": 30, "impact": "high"})) == []


def test_ai_regime_model_off_is_not_available() -> None:
    ignore = _with_filter(
        {
            "type": "ai_regime",
            "regime": "trending",
            "minProbability": 0.6,
            "whenUnavailable": "ignore",
        }
    )
    out = backtest(BacktestRunRequest.model_validate(ignore))
    assert len(out["trades"]) == 4
    regime = out["trades"][0]["entrySignal"]["conditions"][1]
    assert regime == {
        "block": "filter",
        "index": 0,
        "type": "ai_regime",
        "label": "AI regime = trending (p > 0.6)",
        "result": "not_available",
        "values": {"probability": None},
        "contribution": None,
        "skipped": True,
    }
    block = _with_filter(
        {
            "type": "ai_regime",
            "regime": "trending",
            "minProbability": 0.6,
            "whenUnavailable": "block",
        }
    )
    assert _entries(block) == []


def test_portfolio_max_open_positions_across_symbols() -> None:
    req = toy_request()
    req["definition"] = copy.deepcopy(req["definition"])
    req["definition"]["universe"]["symbols"] = ["TOY", "TOY2"]
    req["data"].append({"symbol": "TOY2", "bars": bars_wire(TOY_BARS), "costs": TOY_COSTS})
    out = backtest(BacktestRunRequest.model_validate(req))
    assert {t["symbol"] for t in out["trades"]} == {"TOY"}
    assert out["blocked"]["max_open_positions"] >= 1
    req["definition"]["size"]["maxOpenPositions"] = 2
    two = backtest(BacktestRunRequest.model_validate(req))
    assert len([t for t in two["trades"] if t["symbol"] == "TOY2"]) == 4


def test_sizing_models_and_minimum_quantity() -> None:
    base: dict[str, Any] = {
        "definition": ema_cross_definition(),
        "data": [{"symbol": "SYN", "bars": bars_wire(synthetic_series(800)), "costs": SYN_COSTS}],
    }
    risk = backtest(BacktestRunRequest.model_validate(base))
    t0 = risk["trades"][0]
    risk_amt = abs(float(t0["entryPrice"]) - float(t0["stopInitial"])) * float(t0["qty"])
    assert (
        900 < risk_amt < 1100
    )  # ≈ 1 % of 100,000 (the stop is re-anchored on the ask at the fill)
    vt = copy.deepcopy(base)
    vt["definition"]["size"] = {
        "kind": "vol_target",
        "annualVolPct": 10,
        "lookback": 20,
        "maxOpenPositions": 1,
    }
    out = backtest(BacktestRunRequest.model_validate(vt))
    assert out["trades"] and all(float(t["qty"]) > 0 for t in out["trades"])
    tiny = copy.deepcopy(base)
    tiny["data"][0]["costs"] = {**SYN_COSTS, "minQty": "1000000", "qtyStep": "1"}
    blocked = backtest(BacktestRunRequest.model_validate(tiny))
    assert blocked["trades"] == [] and blocked["blocked"]["size_below_minimum"] > 0


def test_overnight_funding_is_charged_per_roll() -> None:
    rows = (
        [(100.0, 100.5, 99.5, 100.0)] * 5
        + [(100.0, 103.0, 99.9, 102.0)]
        + [(102.0, 102.5, 101.5, 102.0)] * 60
    )
    d = {
        **toy_request()["definition"],
        "exit": {"stop": {"kind": "percent", "pct": 20}, "timeStopBars": 40, "conditions": []},
    }
    costs = {**TOY_COSTS, "swapLongBps": -3600.0}
    out = backtest(
        BacktestRunRequest.model_validate(
            {"definition": d, "data": [{"symbol": "TOY", "bars": bars_wire(rows), "costs": costs}]}
        )
    )
    t = out["trades"][0]
    assert t["swap"] < 0  # at least one 21:00 UTC roll crossed while long
    assert round(t["netPnl"] - (t["grossPnl"] - t["commission"] + t["swap"]), 6) == 0


def test_signal_percent_target_and_short_position() -> None:
    req = toy_request()
    pos = {
        "side": "short",
        "qty": "1",
        "entryRef": 110.0,
        "stop": 115.0,
        "initialStop": 115.0,
        "barsHeld": 0,
        "highWater": 110.0,
    }
    s = signal(
        SignalRequest.model_validate(
            {
                "definition": req["definition"],
                "data": req["data"][0],
                "position": pos,
                "equity": 1000,
            }
        )
    )
    assert s["action"] == "hold" and s["highWater"] == 108.5
