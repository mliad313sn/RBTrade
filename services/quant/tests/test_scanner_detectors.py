"""Scanner detectors against values worked out by hand on short fixed series (SIMULATED numbers).

Small windows (fast=3, slow=4, adx=2, breakout=3, season=2) keep every figure checkable with a
pencil; each expected value is written as the arithmetic that produces it.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from kora_quant.bt import indicators as bt_ind
from kora_quant.scanner import detectors, kernels
from kora_quant.scanner.panel import Panel, ScanConfig, build_panel

HOUR = 3_600_000
T0 = 1_767_571_200_000  # 2026-01-05T00:00:00Z
CFG = ScanConfig(fast=3, slow=4, adx=2, breakout=3, season=2)

A = [100.0, 102.0, 101.0, 104.0, 108.0, 107.0, 110.0]
B = [50.0, 50.0, 51.0, 50.0, 52.0, 53.0, 54.0]
C = [20.0, 21.0, 20.0, 22.0, 22.0, 21.0, 23.0]
VOL = [10.0, 20.0, 30.0, 10.0, 40.0, 10.0, 10.0]


def _series(
    c: list[float],
) -> tuple[list[int], list[float], list[float], list[float], list[float], list[float]]:
    o = [c[0], *c[:-1]]
    return (
        [T0 + i * HOUR for i in range(len(c))],
        o,
        [x + 1.0 for x in c],
        [x - 1.0 for x in c],
        c,
        VOL[: len(c)],
    )


def _panel() -> Panel:
    return build_panel(
        ["A", "B", "C"],
        [_series(A), _series(B), _series(C)],
        HOUR,
        sectors=["tech", "tech", "energy"],
        regions=["asia", "asia", "asia"],
        events=[[T0 + 5 * HOUR], [], []],
    )


@pytest.fixture(scope="module")
def feats() -> detectors.Features:
    return detectors.compute(_panel(), CFG)


def test_breakout_and_channel_position(feats: detectors.Features) -> None:
    bo = feats["breakout"][0]
    # t=0..2: no full previous window of 3 bars.
    assert np.isnan(bo[:3]).all()
    # t=3: previous highs 101, 103, 102 → max 103; close 104 > 103 → +1.
    # t=4: previous highs 103, 102, 105 → 105; close 108 → +1.
    # t=5: previous highs 102, 105, 109 → 109, lows 100, 103, 107 → 100; close 107 inside → 0.
    # t=6: previous highs 105, 109, 108 → 109; close 110 → +1.
    assert bo[3:].tolist() == [1.0, 1.0, 0.0, 1.0]
    # channel position at t=5: (107 − 100) / (109 − 100).
    assert feats["channel_pos"][0, 5] == pytest.approx(7 / 9, abs=1e-12)


def test_mean_reversion_z(feats: detectors.Features) -> None:
    mr = feats["mr_z"][0]
    # t=2: closes 100, 102, 101 → mean 101, sample sd 1 → (101 − 101) / 1 = 0.
    assert mr[2] == pytest.approx(0.0, abs=1e-12)
    # t=3: closes 102, 101, 104 → mean 307/3, squared deviations sum 14/3 → sd √(7/3).
    assert mr[3] == pytest.approx((104 - 307 / 3) / math.sqrt(7 / 3), abs=1e-12)


def test_atr_and_adx_match_goal_06_reference(feats: detectors.Features) -> None:
    atr = feats["atr"][0]
    # TR0 = 101 − 99 = 2; TR1 = max(2, |103 − 100|, |101 − 100|) = 3 → ATR(2) at t=1 = 2.5.
    # TR2 = max(2, |102 − 102|, |100 − 102|) = 2 → Wilder: (2.5 × 1 + 2) / 2 = 2.25.
    assert atr[1] == pytest.approx(2.5)
    assert atr[2] == pytest.approx(2.25)
    t, o, h, lo, c, _ = (np.asarray(x) for x in _series(A))
    ref = bt_ind.adx(h, lo, c, 2)
    np.testing.assert_allclose(feats["adx"][0], ref, rtol=1e-12, equal_nan=True)
    np.testing.assert_allclose(atr, bt_ind.atr(h, lo, c, 2), rtol=1e-12, equal_nan=True)
    assert len(t) == len(o)


def test_momentum_z_and_return_z(feats: detectors.Features) -> None:
    r = [math.log(A[i] / A[i - 1]) for i in range(1, len(A))]  # r1..r6
    mean4 = sum(r[0:4]) / 4
    sd_r1_r4 = math.sqrt(sum((x - mean4) ** 2 for x in r[0:4]) / 3)
    # t=5: mom = ln(107 / 101) (close 3 bars back), scaled by the sd of the previous four
    # returns (r1..r4) × √3.
    assert feats["mom_z"][0, 5] == pytest.approx(
        math.log(107 / 101) / (sd_r1_r4 * math.sqrt(3)), rel=1e-12
    )
    # ret_z at t=5: r5 / sd(r1..r4).
    assert feats["ret_z"][0, 5] == pytest.approx(r[4] / sd_r1_r4, rel=1e-12)
    # vol_ratio at t=5: sd(r3..r5) / sd(r2..r5).
    sd3 = float(np.std(r[2:5], ddof=1))
    sd4 = float(np.std(r[1:5], ddof=1))
    assert feats["vol_ratio"][0, 5] == pytest.approx(sd3 / sd4, rel=1e-12)
    assert np.isnan(feats["mom_z"][0, 4])


def test_relative_strength_vs_sector_and_index(feats: detectors.Features) -> None:
    mom = {k: math.log(s[3] / s[0]) for k, s in (("A", A), ("B", B), ("C", C))}
    # Sector peers of A: B only. Region (index) peers: B and C.
    assert feats["rs_sector"][0, 3] == pytest.approx(mom["A"] - mom["B"], abs=1e-12)
    assert feats["rs_index"][0, 3] == pytest.approx(mom["A"] - (mom["B"] + mom["C"]) / 2, abs=1e-12)
    # C has no sector peer.
    assert np.isnan(feats["rs_sector"][2, 3])


def test_volume_z(feats: detectors.Features) -> None:
    lv = [math.log1p(v) for v in VOL]
    prev = lv[0:3]
    m = sum(prev) / 3
    sd = math.sqrt(sum((x - m) ** 2 for x in prev) / 2)
    # t=3: ln(11) against the previous three bars ln(11), ln(21), ln(31).
    assert feats["volume_z"][0, 3] == pytest.approx((lv[3] - m) / sd, rel=1e-12)


def test_event_minutes(feats: detectors.Features) -> None:
    # Bar 0 closes at T0 + 1 h; the event is at T0 + 5 h → 240 minutes. After it: none.
    assert feats["event_minutes"][0, 0] == pytest.approx(240.0)
    assert feats["event_minutes"][0, 4] == pytest.approx(0.0)
    assert np.isnan(feats["event_minutes"][0, 5])
    assert np.isnan(feats["event_minutes"][1, 0])


def test_slope_t_kernel_by_hand() -> None:
    # y = 1, 2, 4 on x = 0, 1, 2: slope 1.5, intercept 5/6, residuals 1/6, −1/3, 1/6, SSE 1/6,
    # se = √((1/6) / 1 / 2) = √(1/12) → t = 1.5 / √(1/12) = 3√3.
    out = kernels.slope_t(np.asarray([[1.0, 2.0, 4.0]]), 3)
    assert out[0, 2] == pytest.approx(3 * math.sqrt(3), rel=1e-12)
    # A perfectly straight line has no residual: capped at +50.
    assert kernels.slope_t(np.asarray([[1.0, 2.0, 3.0]]), 3)[0, 2] == 50.0
    assert kernels.slope_t(np.asarray([[2.0, 2.0, 2.0]]), 3)[0, 2] == 0.0


def test_pct_rank_and_rolling_corr_kernels() -> None:
    # window 1,3,2 → current 2: two of three ≤ 2; 3,2,5 → 5 is the max; 2,5,4 → 2 and 4 ≤ 4.
    out = kernels.pct_rank(np.asarray([[1.0, 3.0, 2.0, 5.0, 4.0]]), 3)
    assert out[0, 2:].tolist() == pytest.approx([2 / 3, 1.0, 2 / 3])
    a = np.asarray([[1.0, 2.0, 3.0, 4.0]])
    assert kernels.rolling_corr(a, a * 2, 3)[0, 3] == pytest.approx(1.0)
    assert kernels.rolling_corr(a, -a, 3)[0, 3] == pytest.approx(-1.0)
    assert np.isnan(kernels.rolling_corr(a, np.ones_like(a), 3)[0, 3])


def test_seasonality_kernel_by_hand() -> None:
    # 12-hour bars alternating 00:00 and 12:00 UTC. At t=4 (00:00) the next bar is at 12:00; the
    # two earlier 12:00 returns are 0.01 and 0.03 → mean 0.02, sd √2·0.01,
    # so t = 0.02 / (sd / √2) = 2.
    half = 12 * HOUR
    t = np.asarray([[T0 + i * half for i in range(6)]], dtype=np.int64)
    r = np.asarray([[math.nan, 0.01, 0.0, 0.03, 0.0, 0.0]])
    out = kernels.seasonality_t(r, t, half, 2)
    assert out[0, 4] == pytest.approx(2.0, rel=1e-12)
    assert np.isnan(out[0, 2])


def test_regime_filter_first_step_by_hand() -> None:
    # Returns ±0.01 then 0: base σ² = 1e-4. First filtered step from a 50/50 prior with x = 0:
    # P(volatile) = (1/2.5) / (1 + 1/2.5) = 2/7. mz = 1.5 → P(trending | calm) = logistic(0) = 1/2.
    r = np.asarray([[math.nan, 0.01, -0.01, 0.01, -0.01, 0.0]])
    mz = np.asarray([[math.nan] * 5 + [1.5]])
    tr, rg, vo = kernels.regime_filter(r, mz, 4, 2.5, 0.97, 1.5, 1.5)
    assert vo[0, 5] == pytest.approx(2 / 7, rel=1e-12)
    assert tr[0, 5] == pytest.approx((5 / 7) * 0.5, rel=1e-12)
    assert tr[0, 5] + rg[0, 5] + vo[0, 5] == pytest.approx(1.0)


def test_regime_probabilities_sum_to_one_and_react_to_a_volatility_burst() -> None:
    rng = np.random.Generator(np.random.PCG64(1))
    r = rng.standard_normal(400) * 0.005
    r[300:320] *= 6.0
    c = 100 * np.exp(np.cumsum(r))
    series = (
        [T0 + i * HOUR for i in range(400)],
        list(c),
        list(c * 1.001),
        list(c * 0.999),
        list(c),
        [1.0] * 400,
    )
    p = build_panel(["X"], [series], HOUR, ["s"], ["r"])
    f = detectors.compute(p, ScanConfig())
    total = f["regime_trending"] + f["regime_ranging"] + f["regime_volatile"]
    ok = ~np.isnan(total)
    np.testing.assert_allclose(total[ok], 1.0, rtol=1e-12)
    calm = float(np.nanmean(f["regime_volatile"][0, 200:290]))
    burst = float(np.nanmean(f["regime_volatile"][0, 305:320]))
    assert burst > 0.8 > 0.3 > calm


def test_numba_kernels_equal_their_python_source() -> None:
    rng = np.random.Generator(np.random.PCG64(4))
    x = 100 + np.cumsum(rng.standard_normal((2, 40)), axis=1)
    x[1, :5] = np.nan
    pairs = [
        (kernels.rolling_mean_std, (x, 5, 1)),
        (kernels.prev_extreme, (x, 4, True)),
        (kernels.prev_extreme, (x, 4, False)),
        (kernels.pct_rank, (x, 6)),
        (kernels.slope_t, (x, 5)),
        (kernels.adx, (x + 1, x - 1, x, 3)),
        (kernels.rolling_corr, (x, x[::-1].copy(), 5)),
        (
            kernels.regime_filter,
            (np.diff(np.log(x), prepend=np.nan), x / 100, 5, 2.5, 0.97, 1.5, 1.5),
        ),
        (
            kernels.seasonality_t,
            (x / 1000, np.tile(np.arange(1, 41, dtype=np.int64) * HOUR, (2, 1)), HOUR, 1),
        ),
    ]
    for fn, args in pairs:
        jit = fn(*args)  # type: ignore[operator]
        py = fn.py_func(*args)  # type: ignore[attr-defined]
        for a, b in zip(
            jit if isinstance(jit, tuple) else (jit,),
            py if isinstance(py, tuple) else (py,),
            strict=True,
        ):
            np.testing.assert_allclose(a, b, rtol=1e-12, equal_nan=True)


def test_classify_labels_from_features_only() -> None:
    base = {
        "slope_t": 0.0,
        "regime_trending": 0.2,
        "regime_volatile": 0.1,
        "regime_ranging": 0.7,
        "breakout": 0.0,
        "mom_z": 0.0,
        "mr_z": 0.0,
        "adx": 20.0,
        "vol_ratio": 1.0,
        "bb_width_pct": 0.5,
    }
    assert detectors.classify(base) == ("range", 0.56)
    up = {**base, "regime_trending": 0.8, "regime_ranging": 0.1, "mom_z": 3.0, "slope_t": 5.0}
    kind, score = detectors.classify(up)  # type: ignore[misc]
    assert kind == "up" and 0 < score <= 1
    assert detectors.classify({**base, "breakout": -1.0, "bb_width_pct": 0.1}) == (
        "breakout_down",
        0.95,
    )
    assert detectors.classify({**base, "regime_volatile": 0.9, "vol_ratio": 2.0})[0] == "vol_regime"  # type: ignore[index]
    assert detectors.classify({**base, "mr_z": 3.0, "mom_z": 1.0, "slope_t": -2.0})[0] == "reversal"  # type: ignore[index]
    assert detectors.classify({**base, "slope_t": math.nan}) is None
    assert detectors.classify({**base, "regime_ranging": 0.3}) is None
