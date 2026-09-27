"""IRTC R3 scanner regressions (SIMULATED random walks only).

- R3-03: replayed out-of-sample forecasts sit on a fixed calendar grid (multiples of the horizon),
  so consecutive hourly scans produce the same prediction times (idempotent inserts) instead of a
  new overlapping phase per scan.
- R3-04: cross-sectional features match peers by wall-clock time.
- R3-05: the scanner guard is never vacuous and cuts prefixes by wall-clock time.
- R3-09: the isotonic calibrator never says 0 or 1.
- R3-12: each fold's calibrator is fitted only on rows whose label window ended before the fold.
"""

from __future__ import annotations

import itertools
from typing import Any

import numpy as np
import pytest

from kora_quant.bt.evaluate import LookAheadError
from kora_quant.scanner import detectors
from kora_quant.scanner.guard import verify_scan_point_in_time
from kora_quant.scanner.panel import Panel, ScanConfig, build_panel
from kora_quant.scanner.service import ScanRequest, run_scan

H = 3_600_000
T0 = 1_767_571_200_000  # 2026-01-05T00:00:00Z


def _wire(ts: np.ndarray, c: np.ndarray) -> dict[str, Any]:
    o = np.r_[c[0], c[:-1]]
    return {
        "t": [int(x) for x in ts],
        "o": [float(x) for x in o],
        "h": [float(x) for x in np.maximum(o, c) * 1.0005],
        "l": [float(x) for x in np.minimum(o, c) * 0.9995],
        "c": [float(x) for x in c],
        "v": [1.0] * len(c),
    }


def _walks(n: int, k: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    common = rng.standard_normal(n) * 0.004
    return np.stack(
        [100 * np.exp(np.cumsum(common + rng.standard_normal(n) * 0.004)) for _ in range(k)]
    )


def _scan(closes: np.ndarray, ts: np.ndarray, width: int, **extra: Any) -> dict[str, Any]:
    return run_scan(
        ScanRequest.model_validate(
            {
                "timeframe": "1h",
                "tfSeconds": 3600,
                "width": width,
                "guard": False,
                "instruments": [
                    {"symbol": f"S{i}", "sector": "x", "region": "R", "bars": _wire(ts, c)}
                    for i, c in enumerate(closes)
                ],
                "forecast": {"horizons": [{"label": "1d", "bars": 24}], "minTrain": 200},
                **extra,
            }
        )
    )


def _replay_times(out: dict[str, Any]) -> dict[str, list[int]]:
    return {it["symbol"]: [o["ts"] for o in it["forecasts"][0]["oos"]] for it in out["instruments"]}


def test_replayed_forecasts_sit_on_a_fixed_grid_so_rescans_deduplicate() -> None:
    n = 1200
    closes = _walks(n + 3, 2, seed=4)
    ts = T0 + np.arange(n + 3, dtype=np.int64) * H
    grid = 24 * H
    seen: list[dict[str, list[int]]] = []
    for shift in range(3):  # three consecutive hourly scans (the window slides by one bar)
        out = _scan(closes[:, shift : shift + n], ts[shift : shift + n], width=n)
        seen.append(_replay_times(out))
    for times in seen:
        for sym, ps in times.items():
            assert ps, sym
            assert all(p % grid == 0 for p in ps), (sym, ps[:3])
            assert all(b - a >= grid for a, b in itertools.pairwise(ps))
    # Every time replayed by a later scan that was inside the earlier window was replayed before.
    for sym in seen[0]:
        a, b = set(seen[0][sym]), set(seen[1][sym])
        inner = {p for p in b if min(a) <= p <= max(a)}
        assert inner <= a, sorted(inner - a)[:3]


# --- R3-04: cross-sectional features align peers by wall-clock time -----------------------------


def _stale_pair(seed: int, lag: int, n: int = 3000) -> tuple[dict[str, Any], dict[str, Any]]:
    """A and B share a common factor on one hourly grid; B's history ends `lag` bars before A's
    (venue closed, halted or stale feed at scan time)."""
    rng = np.random.default_rng(seed)
    m = n + lag
    f = rng.standard_normal(m) * 0.006
    ca = 100 * np.exp(np.cumsum(f + rng.standard_normal(m) * 0.0018))
    cb = 100 * np.exp(np.cumsum(f + rng.standard_normal(m) * 0.0018))
    ts = T0 + np.arange(m, dtype=np.int64) * H
    return _wire(ts[-n:], ca[-n:]), _wire(ts[:n], cb[:n])


def _pair_panel(a: dict[str, Any], b: dict[str, Any]) -> Panel:
    return build_panel(
        ["A", "B"],
        [(x["t"], x["o"], x["h"], x["l"], x["c"], x["v"]) for x in (a, b)],
        H,
        ["x", "x"],
        ["R", "R"],
    )


def _pair_scan(a: dict[str, Any], b: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return run_scan(
        ScanRequest.model_validate(
            {
                "timeframe": "1h",
                "tfSeconds": 3600,
                "width": len(a["t"]),
                "instruments": [
                    {"symbol": "A", "sector": "x", "region": "R", "bars": a},
                    {"symbol": "B", "sector": "x", "region": "R", "bars": b, "costFraction": 5e-4},
                ],
                **extra,
            }
        )
    )


def test_stale_instrument_never_sees_peers_later_bars() -> None:
    """B's relative strength at its last bar may only use A's bar at the same wall-clock time."""
    a, b = _stale_pair(1, lag=4, n=400)
    cfg = ScanConfig()
    p = _pair_panel(a, b)
    f = detectors.compute(p, cfg)
    logc = np.log(p.c)
    mom = logc - np.roll(logc, cfg.fast, axis=1)
    col_a = int(np.nonzero(p.t[0] == p.t[1, -1])[0][0])  # A's column at B's last wall-clock time
    assert col_a == p.width - 1 - 4
    expected = mom[1, -1] - mom[0, col_a]
    assert f["rs_index"][1, -1] == pytest.approx(expected, rel=1e-9)


def test_stale_instrument_shows_no_fake_forecast_skill() -> None:
    """The IRTC R3-04 reproduction: with right-aligned columns, B's 8-bar forecast showed skill in
    8/8 seeds (hit rate 0.60, t 4.1) because its features held A's future bars."""
    skilled = 0
    for seed in range(4):
        a, b = _stale_pair(seed, lag=4)
        out = _pair_scan(
            a,
            b,
            guard=False,
            forecast={"horizons": [{"label": "8h", "bars": 8}], "minTrain": 300, "symbols": ["B"]},
        )
        sk = next(i for i in out["instruments"] if i["symbol"] == "B")["forecasts"][0]["skill"]
        skilled += bool(sk["hasSkill"])
    assert skilled == 0


# --- R3-05: the look-ahead guard is never vacuous and checks prefixes by wall-clock time ---------


def _panel(n: int = 5, w: int = 600, seed: int = 3) -> Panel:
    rng = np.random.default_rng(seed)
    series = []
    for _ in range(n):
        c = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, w)))
        o = np.r_[100, c[:-1]]
        series.append(
            (
                [T0 + k * H for k in range(w)],
                list(o),
                list(np.maximum(o, c) * 1.002),
                list(np.minimum(o, c) * 0.998),
                list(c),
                [1.0] * w,
            )
        )
    return build_panel([f"S{i}" for i in range(n)], series, H, ["a"] * n, ["r"] * n)


def _next_bar_leak(pp: Panel, cfg: ScanConfig) -> detectors.Features:
    """Next bar's return, NaN during the warm-up like every real detector (IRTC e_guard)."""
    f = detectors.compute(pp, cfg)
    r = detectors.log_returns(pp.c)
    fut = np.full(r.shape, np.nan)
    fut[:, :-1] = r[:, 1:]
    fut[:, :101] = np.nan
    f["mom_z"] = fut
    return f


def test_scanner_guard_catches_a_warmup_respecting_leak_with_the_old_default() -> None:
    p, cfg = _panel(), ScanConfig()
    full = _next_bar_leak(p, cfg)
    for requested in (1, 2):  # the api default was 2: columns {0, w-1} compared nothing
        with pytest.raises(LookAheadError, match="mom_z"):
            verify_scan_point_in_time(p, cfg, full, requested, fn=_next_bar_leak)


def test_scanner_guard_catches_the_right_aligned_cross_section_leak() -> None:
    """The pre-fix cross-sectional mean (by column, not by time) leaks a stale instrument's peers'
    later bars. A wall-clock prefix guard sees it; a column-prefix guard could not."""
    p = _pair_panel(*_stale_pair(2, lag=4, n=500))

    def by_column(pp: Panel, cfg: ScanConfig) -> detectors.Features:
        f = detectors.compute(pp, cfg)
        logc = np.log(pp.c)
        mom = logc - np.roll(logc, cfg.fast, axis=1)
        mom[:, : cfg.fast] = np.nan
        f["rs_index"] = mom - mom[::-1]  # the peer at the same column, whatever its time
        return f

    cfg = ScanConfig()
    with pytest.raises(LookAheadError, match="rs_index"):
        verify_scan_point_in_time(p, cfg, by_column(p, cfg), 8, fn=by_column)


def test_scanner_guard_reports_how_much_it_compared(monkeypatch: pytest.MonkeyPatch) -> None:
    out = _pair_scan(*_stale_pair(5, lag=0, n=400), guardCheckpoints=2)
    g = out["guard"]
    assert g["checkpoints"] >= 8 and g["compared"] > 0 and g["passed"] is True

    real = detectors.compute

    def warming_up(pp: Panel, cfg: ScanConfig) -> detectors.Features:
        return {k: np.full_like(v, np.nan) for k, v in real(pp, cfg).items()}

    # Every value still warming up: nothing was compared, so the scan is not reported as verified.
    monkeypatch.setattr(detectors, "compute", warming_up)
    blank = _pair_scan(*_stale_pair(5, lag=0, n=400))
    assert blank["guard"]["compared"] == 0 and blank["guard"]["passed"] is False


# --- R3-09: calibrated probabilities are never exactly 0 or 1 -----------------------------------


def test_isotonic_calibrator_never_claims_certainty_on_noise() -> None:
    from kora_quant.scanner import calibrate
    from kora_quant.scanner.forecast import FORECAST_FEATURES, ForecastConfig, forecast

    s = np.linspace(0, 1, 300)
    iso = calibrate.fit_calibrator(s, (s > 0.99).astype(np.float64))
    top = iso.predict(np.asarray([1.0]))[0]
    assert 0.5 < top < 1.0  # a 3-point all-success block reads (3 + 1) / (3 + 2) = 0.8
    extreme = 0
    for seed in range(10):
        rng = np.random.default_rng(seed)
        n = 1000
        c = 100 * np.exp(np.cumsum(rng.normal(0, 0.006, n)))
        o = np.r_[100, c[:-1]]
        p = build_panel(
            ["X"],
            [
                (
                    [T0 + k * H for k in range(n)],
                    list(o),
                    list(np.maximum(o, c) * 1.001),
                    list(np.minimum(o, c) * 0.999),
                    list(c),
                    [1.0] * n,
                )
            ],
            H,
            ["s"],
            ["r"],
        )
        x = detectors.matrix(detectors.compute(p, ScanConfig()), FORECAST_FEATURES, 0)
        r = forecast(x, p.c[0], list(FORECAST_FEATURES), ForecastConfig(horizon=24))
        ps = np.array([q.p_up for q in r.oos])
        extreme += int(np.count_nonzero((ps >= 0.999) | (ps <= 0.001)))
    assert extreme == 0


# --- R3-12: the fold calibrator respects the h-bar embargo ---------------------------------------


def test_fold_calibrators_only_see_rows_labelled_before_the_fold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from kora_quant.scanner import calibrate
    from kora_quant.scanner import forecast as fc

    seen: list[int] = []
    real = calibrate.fit_calibrator

    def spy(s: np.ndarray, y: np.ndarray, *a: Any, **k: Any) -> calibrate.Calibrator:
        seen.append(len(s))
        return real(s, y, *a, **k)

    monkeypatch.setattr(fc, "fit_calibrator", spy)
    rng = np.random.default_rng(8)
    n, h = 1200, 24
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.006, n)))
    x = np.stack([np.r_[np.nan, np.diff(np.log(c))], rng.standard_normal(n)], axis=1)
    res = fc.forecast(x, c, ["r", "z"], fc.ForecastConfig(horizon=h, folds=5, min_train=200))
    assert res.status == "ok"
    labelled = np.nonzero(np.isfinite(x).all(axis=1) & (np.arange(n) + h < n))[0]
    plan = fc.fold_plan(labelled, 200, 5, h)
    # Expected calibrator sizes: earlier test rows t with t + h < this fold's first bar.
    tested: list[int] = []
    expected = []
    for _, block in plan:
        expected.append(sum(1 for t in tested if t + h < int(block[0])))
        tested.extend(int(t) for t in block)
    assert seen[: len(expected)] == expected
