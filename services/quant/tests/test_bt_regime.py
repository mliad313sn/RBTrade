"""Goal 07B fills the goal 06 `ai_regime` condition with the scanner's point-in-time regime
model."""

from __future__ import annotations

import copy
from typing import Any

import numpy as np
import pytest

from bt_helpers import SYN_COSTS, bars_wire, syn_request, synthetic_series
from kora_quant.bt import indicators as ind
from kora_quant.bt.evaluate import LookAheadError
from kora_quant.bt.models import BacktestRunRequest, SignalRequest
from kora_quant.bt.research import backtest, signal


def _regime_request(min_p: float, when: str = "block", ai_regime: str = "model") -> dict[str, Any]:
    req = syn_request(900)
    req["definition"] = copy.deepcopy(req["definition"])
    req["definition"]["filters"] = [
        {
            "type": "ai_regime",
            "regime": "trending",
            "minProbability": min_p,
            "whenUnavailable": when,
        }
    ]
    req["aiRegime"] = ai_regime
    return req


def _regime_conds(out: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        c for t in out["trades"] for c in t["entrySignal"]["conditions"] if c["type"] == "ai_regime"
    ]


def test_model_on_fills_the_condition_with_a_probability() -> None:
    out = backtest(BacktestRunRequest.model_validate(_regime_request(0.0)))
    conds = _regime_conds(out)
    assert conds, "expected trades"
    for c in conds:
        p = c["values"]["probability"]
        assert 0.0 <= p <= 1.0
        assert c["result"] is True  # p > 0 always passes
        assert c["contribution"] is not None and not c["skipped"]
    assert out["guard"]["passed"] is True


def test_threshold_blocks_entries_when_the_regime_is_not_trending() -> None:
    loose = backtest(BacktestRunRequest.model_validate(_regime_request(0.0)))
    strict = backtest(BacktestRunRequest.model_validate(_regime_request(0.999)))
    assert len(strict["trades"]) < len(loose["trades"])


def test_model_off_keeps_the_goal_06_behaviour() -> None:
    out = backtest(BacktestRunRequest.model_validate(_regime_request(0.5, "ignore", "off")))
    conds = _regime_conds(out)
    assert conds and all(c["result"] == "not_available" and c["skipped"] for c in conds)


def test_warm_up_is_not_available() -> None:
    probs = ind.REGISTRY["regime_trending"](
        ind.Bars(
            np.arange(50, dtype=np.int64),
            np.full(50, 100.0),
            np.full(50, 101.0),
            np.full(50, 99.0),
            np.linspace(100, 101, 50),
            np.ones(50),
        ),
        0,
        8760.0,
    )
    assert np.isnan(probs).all()  # fewer bars than the 100-bar volatility base


def test_signal_endpoint_reads_the_same_probability() -> None:
    req = _regime_request(0.0)
    sig = signal(
        SignalRequest.model_validate(
            {
                "definition": req["definition"],
                "data": {
                    "symbol": "SYN",
                    "bars": bars_wire(synthetic_series(400)),
                    "costs": SYN_COSTS,
                },
                "equity": 100_000.0,
                "aiRegime": "model",
            }
        )
    )
    assert "regime_trending" in sig["features"]
    assert 0 <= sig["features"]["regime_trending"] <= 1


def test_the_look_ahead_guard_covers_regime_features(monkeypatch: pytest.MonkeyPatch) -> None:
    def leaky(b: ind.Bars, _n: int, _y: float) -> ind.F:
        out = np.full(len(b), 0.5)
        out[:-1] = (b.c[1:] > b.c[:-1]).astype(float)  # peeks at the next close
        return out

    monkeypatch.setitem(ind.REGISTRY, "regime_trending", leaky)
    with pytest.raises(LookAheadError):
        backtest(BacktestRunRequest.model_validate(_regime_request(0.5)))
