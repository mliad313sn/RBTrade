"""IS/OOS split, warnings, walk-forward, optimisation (cap, OOS ranking), sensitivity, live
signal."""

from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from bt_helpers import (
    SYN_COSTS,
    bars_wire,
    ema_cross_definition,
    syn_request,
    synthetic_series,
    toy_request,
)
from kora_quant.app import create_app
from kora_quant.bt.dsl import StrategyDefinition
from kora_quant.bt.models import (
    BacktestRunRequest,
    OptimiseRequest,
    SensitivityRequest,
    SignalRequest,
    WalkForwardRequest,
)
from kora_quant.bt.research import (
    ResearchError,
    _fold_bounds,
    backtest,
    optimise,
    sensitivity,
    signal,
    walk_forward,
)
from kora_quant.config import Settings

FIXTURE = Path(__file__).parent / "fixtures" / "strategy_templates.json"


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(Settings(env="test", live_trading_enabled=False, port=0))) as c:
        yield c


def test_typescript_templates_parse_in_the_python_mirror() -> None:
    data = json.loads(FIXTURE.read_text())
    assert {t["id"] for t in data["templates"]} == {"trend-x", "meanrev-gold", "breakout-crypto"}
    for t in data["templates"]:
        d = StrategyDefinition.model_validate(t["definition"])
        assert d.schema_version == 1
    assert data["jsonSchema"]["type"] == "object"
    assert "entry" in data["jsonSchema"]["required"]


def test_backtest_split_metrics_warnings_and_overfitting() -> None:
    out = backtest(BacktestRunRequest.model_validate(syn_request(1500)))
    m = out["metrics"]
    assert set(m) == {"inSample", "outOfSample", "all"}
    assert (
        m["inSample"]["trades"] + m["outOfSample"]["trades"]
        == m["all"]["trades"]
        == len(out["trades"])
    )
    assert all(
        t["segment"] == ("oos" if t["entryTs"] >= out["oosStart"] else "is") for t in out["trades"]
    )
    for key in (
        "cagr",
        "sharpe",
        "sortino",
        "calmar",
        "maxDrawdown",
        "maxDrawdownDays",
        "winRate",
        "profitFactor",
        "expectancyR",
        "expectancyCcy",
        "exposurePct",
        "turnover",
        "costDragPct",
    ):
        assert key in m["outOfSample"]
    assert any(w["code"] == "oos_trades_low" for w in out["warnings"])
    assert out["overfitting"]["trials"] == 1
    assert out["trialStats"][0]["params"] == {"fast": 10.0, "slow": 30.0, "stop_atr": 2.0}
    assert len(out["equity"]["t"]) <= 1000
    reasons = {t["reason"] for t in out["trades"]}
    assert reasons & {"stop", "trailing_stop", "target", "exit_signal"}
    # The client cannot lower the trial count: the api sends what it recorded.
    many = backtest(
        BacktestRunRequest.model_validate(
            syn_request(1500, trials={"count": 49, "periodSharpes": [0.01 * i for i in range(49)]})
        )
    )
    assert many["overfitting"]["trials"] == 50
    if out["overfitting"]["dsr"] is not None and many["overfitting"]["dsr"] is not None:
        assert many["overfitting"]["dsr"] <= out["overfitting"]["dsr"]


def test_oos_sharpe_decay_warning_fires() -> None:
    import numpy as np

    from kora_quant.bt.engine import EngineResult
    from kora_quant.bt.research import _warnings

    res = EngineResult(np.array([1]), np.array([1.0]), np.array([False]), [], [], [], {}, 0, 1.0)
    w = _warnings({"sharpe": 2.0, "trades": 150}, {"sharpe": 0.5, "trades": 150}, res)
    assert [x["code"] for x in w] == ["oos_sharpe_decay", "no_trades"]


def test_short_side_and_explicit_oos_start() -> None:
    req = syn_request(1200)
    req["definition"] = ema_cross_definition(side="short")
    req["split"] = {"oosStart": req["data"][0]["bars"]["t"][900]}
    out = backtest(BacktestRunRequest.model_validate(req))
    assert out["oosStart"] == req["data"][0]["bars"]["t"][900]
    assert all(t["side"] == "short" for t in out["trades"])


def test_fold_bounds_anchored_and_rolling() -> None:
    anchored = _fold_bounds(100, "anchored", 4, 0.6)
    assert anchored == [(0, 60, 60, 70), (0, 70, 70, 80), (0, 80, 80, 90), (0, 90, 90, 100)]
    rolling = _fold_bounds(100, "rolling", 4, 0.6)
    assert rolling == [(0, 60, 60, 70), (10, 70, 70, 80), (20, 80, 80, 90), (30, 90, 90, 100)]
    with pytest.raises(ResearchError, match="Too few bars"):
        _fold_bounds(12, "anchored", 6, 0.5)


def test_walk_forward_with_per_fold_reoptimisation() -> None:
    req = WalkForwardRequest.model_validate(
        {
            **syn_request(1600),
            "mode": "rolling",
            "folds": 3,
            "grid": {"fast": [5, 10], "slow": [30, 40]},
        }
    )
    out = walk_forward(req)
    assert len(out["folds"]) == 3
    assert out["reoptimised"] is True
    assert all(f["testStart"] >= f["trainEnd"] - 3_600_000 for f in out["folds"])
    assert all(t["entryTs"] >= out["folds"][0]["testStart"] for t in out["trades"])
    assert len(out["trialStats"]) == 4
    assert out["metrics"]["trades"] == len(out["trades"])
    fixed = walk_forward(WalkForwardRequest.model_validate({**syn_request(1600), "folds": 2}))
    assert fixed["reoptimised"] is False and len(fixed["trialStats"]) == 1


def test_optimisation_is_capped_and_ranked_by_oos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KORA_BT_MAX_COMBOS", "4")
    with pytest.raises(ResearchError, match="9 parameter combinations requested; the limit is 4"):
        optimise(
            OptimiseRequest.model_validate(
                {**syn_request(900), "grid": {"fast": [5, 10, 15], "slow": [30, 40, 50]}}
            )
        )
    monkeypatch.setenv("KORA_BT_MAX_COMBOS", "50")
    out = optimise(
        OptimiseRequest.model_validate(
            {**syn_request(900), "grid": {"fast": [5, 10, 15], "slow": [30, 40, 50]}}
        )
    )
    assert out["evaluated"] == 9 and out["rankedBy"] == "out_of_sample_sharpe"
    oos = [r["oosSharpe"] for r in out["results"] if r["oosSharpe"] is not None]
    assert oos == sorted(oos, reverse=True)
    assert out["best"] == out["results"][0]
    rnd = optimise(
        OptimiseRequest.model_validate(
            {
                **syn_request(900),
                "method": "random",
                "samples": 3,
                "seed": 5,
                "grid": {"fast": [5, 10, 15], "slow": [30, 40, 50]},
            }
        )
    )
    rnd2 = optimise(
        OptimiseRequest.model_validate(
            {
                **syn_request(900),
                "method": "random",
                "samples": 3,
                "seed": 5,
                "grid": {"fast": [5, 10, 15], "slow": [30, 40, 50]},
            }
        )
    )
    assert rnd["evaluated"] == 3
    assert [r["params"] for r in rnd["results"]] == [r["params"] for r in rnd2["results"]]
    with pytest.raises(ResearchError, match='Unknown parameter "nope"'):
        optimise(OptimiseRequest.model_validate({**syn_request(300), "grid": {"nope": [1]}}))


def test_sensitivity_heatmap_grid() -> None:
    out = sensitivity(
        SensitivityRequest.model_validate(
            {
                **syn_request(900),
                "x": {"param": "fast", "values": [5, 10, 15]},
                "y": {"param": "slow", "values": [30, 40]},
            }
        )
    )
    assert len(out["cells"]) == 2 and all(len(r) == 3 for r in out["cells"])
    assert out["x"]["current"] == 10.0 and out["y"]["current"] == 30.0
    assert len(out["trialStats"]) == 6
    with pytest.raises(ResearchError, match="two different parameters"):
        sensitivity(
            SensitivityRequest.model_validate(
                {
                    **syn_request(300),
                    "x": {"param": "fast", "values": [5, 10]},
                    "y": {"param": "fast", "values": [5, 10]},
                }
            )
        )
    bad = sensitivity(
        SensitivityRequest.model_validate(
            {
                **syn_request(300),
                "x": {"param": "fast", "values": [5, 0.5]},
                "y": {"param": "slow", "values": [30, 40]},
            }
        )
    )
    assert "error" in bad["cells"][0][1]


def test_live_signal_equals_backtest_decisions_bar_by_bar() -> None:
    """Parity by construction: /bt/signal on each prefix reproduces the backtester's entry
    signals."""
    rows = synthetic_series(400, seed=21)
    wire = bars_wire(rows)
    bt = backtest(
        BacktestRunRequest.model_validate(
            {
                "definition": ema_cross_definition(),
                "data": [{"symbol": "SYN", "bars": wire, "costs": SYN_COSTS}],
            }
        )
    )
    entry_bars = {t["entrySignal"]["barTs"] for t in bt["trades"]}
    assert entry_bars
    flat_signals: set[int] = set()
    for end in range(40, 400):
        prefix = {k: v[: end + 1] for k, v in wire.items()}
        s = signal(
            SignalRequest.model_validate(
                {
                    "definition": ema_cross_definition(),
                    "data": {"symbol": "SYN", "bars": prefix, "costs": SYN_COSTS},
                    "equity": 100_000,
                }
            )
        )
        if s["action"] == "enter_long":
            flat_signals.add(s["barTs"])
    # Every backtest entry was a live entry signal on the same bar (the live bot sees the same
    # logic).
    assert entry_bars <= flat_signals


def test_signal_with_position_time_stop_trailing_and_blocked() -> None:
    req = toy_request()
    d = copy.deepcopy(req["definition"])
    d["exit"]["trailing"] = {"afterR": 0.1, "kind": "atr", "multiple": 1, "period": 2}
    data = req["data"][0]
    pos = {
        "side": "long",
        "qty": "1",
        "entryRef": 100.0,
        "stop": 95.0,
        "initialStop": 95.0,
        "barsHeld": 3,
        "highWater": 100.0,
    }
    s = signal(
        SignalRequest.model_validate(
            {"definition": d, "data": data, "position": pos, "equity": 1000}
        )
    )
    assert s["action"] == "exit" and s["reason"] == "time_stop"
    assert s["newStop"] is not None
    blocked = signal(
        SignalRequest.model_validate(
            {
                "definition": req["definition"],
                "data": {**data, "bars": {k: v[:4] for k, v in data["bars"].items()}},
                "equity": 1000,
                "openPositions": 1,
            }
        )
    )
    assert blocked["action"] == "blocked" and blocked["reason"] == "max_open_positions"
    assert blocked["features"]["highest:3"] == 101.0


def test_routes_round_trip_and_plain_422s(client: TestClient) -> None:
    res = client.post("/bt/run", json=toy_request())
    assert res.status_code == 200
    body: dict[str, Any] = res.json()
    assert body["simulated"] is True and len(body["trades"]) == 4
    for path, extra in (
        ("/bt/walk-forward", {"folds": 2}),
        ("/bt/optimise", {"grid": {"x": [1]}}),
        (
            "/bt/sensitivity",
            {"x": {"param": "a", "values": [1, 2]}, "y": {"param": "b", "values": [1, 2]}},
        ),
    ):
        r = client.post(path, json={**toy_request(), **extra})
        assert r.status_code == 422, path
    bad_def = toy_request()
    bad_def["definition"] = {**bad_def["definition"], "schemaVersion": 2}
    r = client.post("/bt/run", json=bad_def)
    assert r.status_code == 422 and r.json()["detail"][0]["loc"][:2] == ["body", "definition"]
    unknown = toy_request(paramOverrides={"zzz": 1})
    r = client.post("/bt/run", json=unknown)
    assert r.status_code == 422 and "Unknown parameter" in r.json()["detail"][0]["msg"]
    short = toy_request()
    short["data"][0]["bars"] = {k: v[:5] for k, v in short["data"][0]["bars"].items()}
    assert client.post("/bt/run", json=short).status_code == 422
    sig = client.post(
        "/bt/signal",
        json={
            "definition": toy_request()["definition"],
            "data": toy_request()["data"][0],
            "equity": 1000,
        },
    )
    assert sig.status_code == 200 and sig.json()["action"] in {"hold", "enter_long", "blocked"}
    wf = client.post("/bt/walk-forward", json={**syn_request(800), "folds": 2})
    assert wf.status_code == 200
    bad_bar = toy_request()
    bad_bar["data"][0]["bars"]["h"][2] = 1.0
    assert client.post("/bt/run", json=bad_bar).status_code == 422
