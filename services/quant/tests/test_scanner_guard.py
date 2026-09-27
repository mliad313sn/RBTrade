"""Look-ahead guard, incremental bar-close scans and the /scanner/run route (SIMULATED data)."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from kora_quant.app import create_app
from kora_quant.bt.evaluate import LookAheadError
from kora_quant.scanner import detectors, synthetic
from kora_quant.scanner.guard import verify_scan_point_in_time
from kora_quant.scanner.incremental import NewBar, ScanState
from kora_quant.scanner.panel import Panel, ScanConfig


@pytest.fixture(scope="module")
def panel() -> Panel:
    p, _, _ = synthetic.universe(30, 260, seed=11)
    return p


def test_guard_passes_on_the_real_detectors(panel: Panel) -> None:
    full = detectors.compute(panel, ScanConfig())
    res = verify_scan_point_in_time(panel, ScanConfig(), full, checkpoints=8)
    assert res.checkpoints >= 8 and res.compared > 0


def test_future_bars_do_not_change_past_features(panel: Panel) -> None:
    cfg = ScanConfig()
    before = detectors.compute(panel, cfg)
    t = 200
    c = panel.c.copy()
    c[:, t + 1 :] *= 3.0  # inject a huge move after bar t
    h = np.maximum(panel.h.copy(), c)
    after = detectors.compute(
        Panel(
            panel.symbols,
            panel.t,
            panel.o,
            h,
            panel.lo,
            c,
            panel.v,
            panel.tf_ms,
            panel.sector,
            panel.region,
            panel.events,
        ),
        cfg,
    )
    for name in detectors.FEATURES:
        np.testing.assert_allclose(
            before[name][:, : t + 1], after[name][:, : t + 1], equal_nan=True, err_msg=name
        )


_REAL_COMPUTE = detectors.compute


def _leaky(p: Panel, cfg: ScanConfig) -> detectors.Features:
    """A detector that peeks one bar ahead (a centred moving average)."""
    f = _REAL_COMPUTE(p, cfg)
    c = p.c
    centred = np.full(c.shape, np.nan)
    centred[:, 1:-1] = (c[:, :-2] + c[:, 1:-1] + c[:, 2:]) / 3.0
    f["mr_z"] = centred
    return f


def test_guard_fails_when_future_data_is_injected(panel: Panel) -> None:
    cfg = ScanConfig()
    full = _leaky(panel, cfg)
    with pytest.raises(LookAheadError, match="Look-ahead detected: scanner feature mr_z"):
        verify_scan_point_in_time(panel, cfg, full, fn=_leaky)


def test_route_refuses_a_leaky_scan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(detectors, "compute", _leaky)
    client = TestClient(create_app())
    res = client.post("/scanner/run", json=_request(8, 150))
    assert res.status_code == 422
    assert res.json()["detail"][0]["type"] == "look_ahead"


def test_incremental_bar_close_matches_a_full_scan() -> None:
    p, _, _ = synthetic.universe(12, 900, seed=5)
    cfg = ScanConfig()
    full = detectors.last_column(detectors.compute(p, cfg))
    state = ScanState(p.prefix(p.width - 1), cfg, window=600)
    last = p.width - 1
    latest = state.on_bar_close(
        {
            i: NewBar(
                int(p.t[i, last]),
                float(p.o[i, last]),
                float(p.h[i, last]),
                float(p.lo[i, last]),
                float(p.c[i, last]),
                float(p.v[i, last]),
            )
            for i in range(p.n)
        }
    )
    for a, b in zip(full, latest, strict=True):
        for name in detectors.FEATURES:
            if np.isnan(a[name]):
                assert np.isnan(b[name]), name
            else:
                assert b[name] == pytest.approx(a[name], rel=1e-6, abs=1e-6), name
    assert state.latest()[0]["adx"] == latest[0]["adx"]


def _request(n: int, bars: int, forecast: bool = False) -> dict[str, object]:
    p, classes, regions = synthetic.universe(n, bars, seed=2)
    instruments = []
    for i in range(n):
        instruments.append(
            {
                "symbol": p.symbols[i],
                "sector": classes[i],
                "region": regions[i],
                "costFraction": 0.0002,
                "events": [int(e) for e in p.events[i]],
                "bars": {
                    "t": [int(x) for x in p.t[i]],
                    "o": p.o[i].tolist(),
                    "h": p.h[i].tolist(),
                    "l": p.lo[i].tolist(),
                    "c": p.c[i].tolist(),
                    "v": p.v[i].tolist(),
                },
            }
        )
    body: dict[str, object] = {"timeframe": "1h", "tfSeconds": 3600, "instruments": instruments}
    if forecast:
        body["forecast"] = {
            "horizons": [{"label": "1d", "bars": 24}, {"label": "1w", "bars": 120}],
            "minTrain": 200,
        }
    return body


def test_route_returns_features_trends_and_forecasts() -> None:
    client = TestClient(create_app())
    res = client.post("/scanner/run", json=_request(6, 700, forecast=True))
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["simulated"] is True
    assert out["guard"]["enabled"] is True and out["guard"]["passed"] is True
    assert out["guard"]["checkpoints"] == 8 and out["guard"]["compared"] > 0
    first = out["instruments"][0]
    assert set(first["features"]) == set(detectors.FEATURES)
    assert all(isinstance(v, float) or v is None for v in first["features"].values())
    fc = {f["horizon"]: f for f in first["forecasts"]}
    assert fc["1d"]["status"] == "ok"
    # Random walk: no demonstrated skill after costs.
    assert fc["1d"]["skill"]["hasSkill"] is False
    oos = fc["1d"]["oos"]
    assert oos and all(o["resolvedTs"] > o["ts"] for o in oos)
    assert all(oos[i + 1]["ts"] - oos[i]["ts"] >= 24 * 3_600_000 for i in range(len(oos) - 1))
    assert fc["1d"]["latest"]["drivers"] and len(fc["1d"]["latest"]["drivers"]) <= 5
    # 700 bars cannot support a 120-bar horizon with 5 folds after 200 training rows.
    assert fc["1w"]["status"] == "insufficient_data"


def test_route_validates_config() -> None:
    client = TestClient(create_app())
    body = _request(2, 50)
    body["config"] = {"fast": 20, "slow": 10}
    assert client.post("/scanner/run", json=body).status_code == 422
