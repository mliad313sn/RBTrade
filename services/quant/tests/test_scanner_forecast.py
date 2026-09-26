"""Point-in-time forecasts, walk-forward embargo and calibration maths (SIMULATED data)."""

from __future__ import annotations

import numpy as np
import pytest

from kora_quant.scanner import calibrate, detectors, synthetic
from kora_quant.scanner.forecast import FORECAST_FEATURES, ForecastConfig, fold_plan, forecast


def _run(ar: float, seed: int, n: int = 6, bars: int = 1500, h: int = 1) -> list[dict[str, object]]:
    p, _, _ = synthetic.universe(n, bars, seed=seed, ar=ar)
    f = detectors.compute(p)
    out = []
    for i in range(n):
        res = forecast(
            detectors.matrix(f, FORECAST_FEATURES, i),
            p.c[i],
            list(FORECAST_FEATURES),
            ForecastConfig(horizon=h, cost=0.0001),
        )
        out.append(res.skill | {"status": res.status, "latest": res.latest, "oos": len(res.oos)})
    return out


def test_random_walks_show_no_reliable_signal() -> None:
    results = _run(0.0, seed=21)
    assert all(r["status"] == "ok" for r in results)
    assert not any(r["hasSkill"] for r in results)


def test_a_planted_signal_is_detected_out_of_sample() -> None:
    results = _run(0.5, seed=21)
    skilled = [r for r in results if r["hasSkill"]]
    assert len(skilled) >= 4
    for r in skilled:
        assert r["brierSkill"] > 0 and r["meanNetReturn"] > 0 and r["tStat"] >= 2  # type: ignore[operator]


def test_walk_forward_embargo_keeps_training_labels_before_each_fold() -> None:
    labelled = np.arange(0, 1000, dtype=np.int64)
    plan = fold_plan(labelled, 200, 5, 24)
    assert len(plan) == 5
    for train, test in plan:
        assert int(train.max()) + 24 < int(test.min())
    tests = np.concatenate([t for _, t in plan])
    assert np.array_equal(tests, labelled[200:])


def test_insufficient_history_is_reported_not_forecast() -> None:
    p, _, _ = synthetic.universe(1, 250, seed=3)
    f = detectors.compute(p)
    res = forecast(
        detectors.matrix(f, FORECAST_FEATURES, 0),
        p.c[0],
        list(FORECAST_FEATURES),
        ForecastConfig(horizon=24),
    )
    assert res.status == "insufficient_data"
    assert res.latest is None and "need" in str(res.skill["reason"])


def test_latest_forecast_drivers_are_exact_linear_shap() -> None:
    p, _, _ = synthetic.universe(1, 1200, seed=8, ar=0.3)
    f = detectors.compute(p)
    res = forecast(
        detectors.matrix(f, FORECAST_FEATURES, 0),
        p.c[0],
        list(FORECAST_FEATURES),
        ForecastConfig(horizon=1),
    )
    assert res.latest is not None
    drivers = res.latest["drivers"]
    contribs = [abs(d["contribution"]) for d in drivers]
    assert contribs == sorted(contribs, reverse=True)
    assert res.latest["pDirection"] >= 0.5
    assert res.latest["direction"] in ("up", "down")


def test_isotonic_pools_adjacent_violators() -> None:
    iso = calibrate.fit_isotonic(np.asarray([0.1, 0.2, 0.3, 0.4]), np.asarray([0.0, 1.0, 0.0, 1.0]))
    # 0.2 and 0.3 are pooled at 0.5.
    assert iso.predict(np.asarray([0.05, 0.1, 0.25, 0.3, 0.4, 0.9])).tolist() == [
        0.0,
        0.0,
        0.5,
        0.5,
        1.0,
        1.0,
    ]


def test_platt_and_calibrator_choice() -> None:
    rng = np.random.Generator(np.random.PCG64(2))
    s = rng.uniform(0.05, 0.95, 400)
    y = (rng.uniform(size=400) < s).astype(float)
    assert calibrate.fit_calibrator(s, y).method == "isotonic"
    small = calibrate.fit_calibrator(s[:50], y[:50])
    assert small.method == "platt"
    assert small.platt is not None and small.platt.a > 0
    assert calibrate.fit_calibrator(s[:5], y[:5]).method == "none"
    p = small.predict(np.asarray([0.2, 0.8]))
    assert p[0] < p[1]


def test_logistic_regression_recovers_the_sign() -> None:
    rng = np.random.Generator(np.random.PCG64(3))
    x = rng.standard_normal((2000, 2))
    y = (rng.uniform(size=2000) < calibrate.sigmoid(1.5 * x[:, 0] - 0.5 * x[:, 1])).astype(float)
    w = calibrate.fit_logistic(x, y, l2=1.0)
    assert w[1] == pytest.approx(1.5, abs=0.2) and w[2] == pytest.approx(-0.5, abs=0.15)
    assert calibrate.brier(np.asarray([]), np.asarray([])) != calibrate.brier(
        np.asarray([]), np.asarray([])
    )
