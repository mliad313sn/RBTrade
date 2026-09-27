"""IRTC R3-01: parameter selection must never read the out-of-sample holdout.

The optimiser and the sensitivity heatmap rank on an inner validation segment (inside the
in-sample window). The holdout is evaluated once, for the selected configuration only. Walk-forward
chooses each fold's parameters on that fold's training data only. All data is SIMULATED noise.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from bt_helpers import SYN_COSTS, bars_wire, ema_cross_definition, synthetic_series
from kora_quant.bt.models import (
    BacktestRunRequest,
    OptimiseRequest,
    SensitivityRequest,
    WalkForwardRequest,
)
from kora_quant.bt.research import backtest, optimise, sensitivity, walk_forward

GRID = {"fast": [3, 6, 10, 16], "slow": [30, 50, 80, 130]}


def random_walk(n: int, seed: int, vol: float = 0.004) -> list[tuple[float, float, float, float]]:
    """Driftless random walk on a 0.01 grid: no parameter set has any edge."""
    rng = np.random.default_rng(seed)
    p = 100.0
    rows: list[tuple[float, float, float, float]] = []
    for _ in range(n):
        o = p
        c = max(1.0, o * math.exp(vol * rng.standard_normal()))
        h = max(o, c) * (1 + abs(rng.standard_normal()) * vol * 0.4)
        lo = min(o, c) * (1 - abs(rng.standard_normal()) * vol * 0.4)
        o, c = round(o, 2), round(c, 2)
        rows.append((o, max(round(h + 0.005, 2), o, c), min(round(lo - 0.005, 2), o, c), c))
        p = c
    return rows


def _request(rows: list[tuple[float, float, float, float]], **extra: Any) -> dict[str, Any]:
    return {
        "definition": ema_cross_definition(),
        "data": [{"symbol": "SYN", "bars": bars_wire(rows), "costs": SYN_COSTS}],
        "capital": 100_000.0,
        **extra,
    }


def _replace_holdout(
    rows: list[tuple[float, float, float, float]], seed: int, oos_fraction: float = 0.3
) -> list[tuple[float, float, float, float]]:
    """Same bars before the holdout, a different random future inside it."""
    cut = int(len(rows) * (1.0 - oos_fraction))
    fresh = random_walk(len(rows) - cut + 1, seed)
    scale = rows[cut - 1][3] / fresh[0][0]
    tail = [
        (round(o * scale, 2), round(h * scale, 2), round(lo * scale, 2), round(c * scale, 2))
        for o, h, lo, c in fresh[1:]
    ]
    tail = [(o, max(h, o, c), min(lo, o, c), c) for o, h, lo, c in tail]
    return rows[:cut] + tail


def test_optimiser_ranking_is_invariant_to_the_holdout_bars() -> None:
    rows = random_walk(1500, seed=11)
    a = optimise(OptimiseRequest.model_validate(_request(rows, grid=GRID)))
    b = optimise(OptimiseRequest.model_validate(_request(_replace_holdout(rows, 99), grid=GRID)))
    assert a["rankedBy"] == "validation_sharpe"
    assert [r["params"] for r in a["results"]] == [r["params"] for r in b["results"]]
    assert a["best"]["params"] == b["best"]["params"]
    # Only the selected configuration is scored on the holdout, and it saw different bars.
    assert all("oosSharpe" not in r for r in a["results"])
    assert a["best"]["holdout"]["sharpe"] != b["best"]["holdout"]["sharpe"]
    vals = [r["validationSharpe"] for r in a["results"] if r["validationSharpe"] is not None]
    assert vals == sorted(vals, reverse=True)
    assert a["validationStart"] < a["oosStart"]


def test_selected_configuration_is_not_the_holdout_maximum_on_noise() -> None:
    """On driftless noise, a selection that never reads the holdout picks a configuration whose
    holdout Sharpe ranks uniformly among all configurations (P(top) = 1/16). Ranking on the
    holdout (the defect) makes the reported "OOS" Sharpe the maximum in every seed."""
    tops = 0
    reported: list[float] = []
    for seed in range(6):
        rows = random_walk(1500, seed)
        out = optimise(OptimiseRequest.model_validate(_request(rows, grid=GRID)))
        best = out["best"]
        chosen = best["holdout"]["sharpe"] if "holdout" in best else best["oosSharpe"]
        reported.append(float("nan") if chosen is None else float(chosen))
        holdouts = []
        for combo in _all_combos():
            bt = backtest(BacktestRunRequest.model_validate(_request(rows, paramOverrides=combo)))
            s = bt["metrics"]["outOfSample"]["sharpe"]
            holdouts.append(-math.inf if s is None else float(s))
        others = [h for c, h in zip(_all_combos(), holdouts, strict=True) if c != best["params"]]
        if chosen is not None and float(chosen) > max(others):
            tops += 1
    assert tops <= 2, (tops, reported)


def _all_combos() -> list[dict[str, float]]:
    return [{"fast": float(f), "slow": float(s)} for f in GRID["fast"] for s in GRID["slow"]]


def test_sensitivity_heatmap_scores_validation_not_the_holdout() -> None:
    rows = random_walk(1500, seed=5)
    body = {
        "x": {"param": "fast", "values": [5, 10]},
        "y": {"param": "slow", "values": [30, 60]},
    }
    a = sensitivity(SensitivityRequest.model_validate(_request(rows, **body)))
    b = sensitivity(SensitivityRequest.model_validate(_request(_replace_holdout(rows, 7), **body)))
    assert a["metric"] == "validation_sharpe"
    cells_a = [c["validationSharpe"] for row in a["cells"] for c in row]
    cells_b = [c["validationSharpe"] for row in b["cells"] for c in row]
    assert cells_a == cells_b
    assert all("oosSharpe" not in c for row in a["cells"] for c in row)


def test_walk_forward_fold_choice_uses_in_fold_data_only() -> None:
    rows = synthetic_series(1600, seed=3)
    req = {**_request(rows), "folds": 2, "grid": {"fast": [5, 10], "slow": [30, 40]}}
    a = walk_forward(WalkForwardRequest.model_validate(req))
    # Change every bar after fold 1's training window: fold 1's choice must not move.
    train_end_idx = int(1600 * 0.6)
    changed = rows[:train_end_idx] + _replace_holdout(rows, 17, 0.4)[train_end_idx:]
    b = walk_forward(WalkForwardRequest.model_validate({**req, **_request(changed)}))
    assert a["folds"][0]["params"] == b["folds"][0]["params"]
    assert a["folds"][0]["isSharpe"] == b["folds"][0]["isSharpe"]
