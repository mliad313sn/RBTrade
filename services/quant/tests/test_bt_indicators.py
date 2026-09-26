"""Indicators against hand-computed values."""

from __future__ import annotations

import math

import numpy as np
import pytest

from kora_quant.bt import indicators as ind


def arr(*xs: float) -> ind.F:
    return np.array(xs, dtype=np.float64)


def test_sma_and_ema_by_hand() -> None:
    x = arr(1, 2, 3, 4, 5)
    assert np.isnan(ind.sma(x, 3)[:2]).all()
    assert ind.sma(x, 3)[2:].tolist() == [2.0, 3.0, 4.0]
    e = ind.ema(x, 3)  # alpha 0.5, seed SMA(1,2,3)=2 → 3 → 4
    assert np.isnan(e[:2]).all()
    assert e[2:].tolist() == [2.0, 3.0, 4.0]
    e2 = ind.ema(arr(10, 10, 10, 20), 3)
    assert e2[3] == pytest.approx(15.0)
    assert np.isnan(ind.ema(arr(1, 2), 3)).all()
    assert np.isnan(ind.sma(arr(1, 2), 3)).all()


def test_rsi_extremes_and_wilder_step() -> None:
    up = arr(1, 2, 3, 4, 5, 6)
    assert ind.rsi(up, 3)[3:].tolist() == [100.0, 100.0, 100.0]
    x = arr(10, 11, 10, 11, 12)  # changes +1 −1 +1 +1
    r = ind.rsi(x, 2)
    # first: ag=0.5 al=0.5 → 50; next: ag=(0.5+1)/2=0.75, al=(0.5+0)/2=0.25 → 75; next ag=0.875
    # al=0.125 → 87.5
    assert r[2:].tolist() == pytest.approx([50.0, 75.0, 87.5])
    assert np.isnan(ind.rsi(arr(1, 2), 3)).all()


def test_true_range_and_atr() -> None:
    h, lo, c = arr(10, 12, 11), arr(8, 9, 7), arr(9, 11, 8)
    assert ind.true_range(h, lo, c).tolist() == [2.0, 3.0, 4.0]
    a = ind.atr(h, lo, c, 2)
    assert math.isnan(a[0])
    assert a[1] == 2.5
    assert a[2] == pytest.approx((2.5 * 1 + 4.0) / 2)


def test_adx_on_a_pure_uptrend_is_100() -> None:
    n = 40
    c = np.arange(100.0, 100.0 + n)
    a = ind.adx(c + 0.5, c - 0.5, c, 5)
    assert np.isnan(a[: 2 * 5 - 1]).all()
    assert a[-1] == pytest.approx(100.0)
    assert np.isnan(ind.adx(c[:4], c[:4], c[:4], 5)).all()
    flat = np.full(30, 100.0)
    assert ind.adx(flat, flat, flat, 5)[-1] == 0.0


def test_breakout_extremes_exclude_the_current_bar_roc_and_vol() -> None:
    h = arr(1, 5, 3, 4, 10)
    assert np.isnan(ind.highest(h, 3)[:3]).all()
    assert ind.highest(h, 3)[3:].tolist() == [5.0, 5.0]
    assert ind.lowest(h, 2)[2:].tolist() == [1.0, 3.0, 3.0]
    assert ind.roc(arr(100, 110, 121), 1)[1:] == pytest.approx([10.0, 10.0])
    geo = 100.0 * np.exp(0.01 * np.arange(20))
    assert ind.realised_vol(geo, 5, 252.0)[-1] == pytest.approx(0.0, abs=1e-9)
    assert np.isnan(ind.realised_vol(geo[:3], 5, 252.0)).all()


def test_registry_prefix_view() -> None:
    b = ind.Bars(
        np.arange(5, dtype=np.int64),
        arr(1, 2, 3, 4, 5),
        arr(2, 3, 4, 5, 6),
        arr(0, 1, 2, 3, 4),
        arr(1, 2, 3, 4, 5),
        arr(1, 1, 1, 1, 1),
    )
    p = b.prefix(3)
    assert len(p) == 3
    for name, fn in ind.REGISTRY.items():
        assert len(fn(b, 2, 252.0)) == 5, name
