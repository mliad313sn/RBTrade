"""Causal technical indicators on bar arrays (float64, NaN during warm-up).

Every function uses only bars 0..t to produce value t. The engine enforces this with a mandatory
prefix-invariance guard (`evaluate.verify_point_in_time`), so a non-causal indicator fails the run.

Conventions (documented in docs/quant/backtester.md):
- EMA: alpha = 2/(n+1), seeded with the SMA of the first n values (first value at index n-1).
- RSI, ATR, ADX: Wilder smoothing. ATR's first value is the mean true range of bars 0..n-1.
- `highest` / `lowest`: the extreme of the previous n bars, excluding the current bar (breakouts).
- `realised_vol`: sample stdev of log returns over n bars, annualised with the bar frequency, in %.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np
from numpy.typing import NDArray

F = NDArray[np.float64]


def _nan(n: int) -> F:
    return np.full(n, np.nan, dtype=np.float64)


def sma(x: F, n: int) -> F:
    out = _nan(len(x))
    if len(x) < n:
        return out
    c = np.cumsum(np.insert(x, 0, 0.0))
    out[n - 1 :] = (c[n:] - c[:-n]) / n
    return out


def ema(x: F, n: int) -> F:
    out = _nan(len(x))
    if len(x) < n:
        return out
    alpha = 2.0 / (n + 1.0)
    prev = float(np.mean(x[:n]))
    out[n - 1] = prev
    for i in range(n, len(x)):
        prev = alpha * x[i] + (1.0 - alpha) * prev
        out[i] = prev
    return out


def _wilder(x: F, n: int, start: int) -> F:
    """Wilder smoothing of x starting with the mean of x[start:start+n] at index start+n-1."""
    out = _nan(len(x))
    first = start + n - 1
    if len(x) <= first:
        return out
    prev = float(np.mean(x[start : start + n]))
    out[first] = prev
    for i in range(first + 1, len(x)):
        prev = (prev * (n - 1) + x[i]) / n
        out[i] = prev
    return out


def true_range(h: F, lo: F, c: F) -> F:
    tr = h - lo
    if len(c) > 1:
        prev = c[:-1]
        tr[1:] = np.maximum.reduce([h[1:] - lo[1:], np.abs(h[1:] - prev), np.abs(lo[1:] - prev)])
    return tr


def atr(h: F, lo: F, c: F, n: int) -> F:
    return _wilder(true_range(h, lo, c), n, 0)


def rsi(c: F, n: int) -> F:
    out = _nan(len(c))
    if len(c) <= n:
        return out
    d = np.diff(c)
    gain = np.where(d > 0, d, 0.0)
    loss = np.where(d < 0, -d, 0.0)
    ag = float(np.mean(gain[:n]))
    al = float(np.mean(loss[:n]))
    for i in range(n, len(c)):
        if i > n:
            ag = (ag * (n - 1) + gain[i - 1]) / n
            al = (al * (n - 1) + loss[i - 1]) / n
        # A flat window (no gains, no losses) is 50, as in the chart and alert library
        # (packages/domain/src/indicators.ts; IRTC R3-13).
        out[i] = (50.0 if ag == 0 else 100.0) if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    return out


def adx(h: F, lo: F, c: F, n: int) -> F:
    size = len(c)
    out = _nan(size)
    if size < n + 1:
        return out
    up = np.zeros(size)
    down = np.zeros(size)
    up_move = h[1:] - h[:-1]
    down_move = lo[:-1] - lo[1:]
    up[1:] = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    down[1:] = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    tr = true_range(h, lo, c)
    # Wilder sums (not means) over bars 1..n, then smoothed: S_t = S_{t-1} - S_{t-1}/n + x_t.
    s_tr = float(np.sum(tr[1 : n + 1]))
    s_up = float(np.sum(up[1 : n + 1]))
    s_dn = float(np.sum(down[1 : n + 1]))
    dx = _nan(size)
    for i in range(n, size):
        if i > n:
            s_tr = s_tr - s_tr / n + tr[i]
            s_up = s_up - s_up / n + up[i]
            s_dn = s_dn - s_dn / n + down[i]
        if s_tr <= 0:
            dx[i] = 0.0
            continue
        pdi = 100.0 * s_up / s_tr
        mdi = 100.0 * s_dn / s_tr
        dx[i] = 0.0 if pdi + mdi == 0 else 100.0 * abs(pdi - mdi) / (pdi + mdi)
    return _wilder(np.nan_to_num(dx, nan=0.0), n, n)


def roc(c: F, n: int) -> F:
    out = _nan(len(c))
    if len(c) > n:
        out[n:] = (c[n:] / c[:-n] - 1.0) * 100.0
    return out


def highest(h: F, n: int) -> F:
    out = _nan(len(h))
    for i in range(n, len(h)):
        out[i] = float(np.max(h[i - n : i]))
    return out


def lowest(lo: F, n: int) -> F:
    out = _nan(len(lo))
    for i in range(n, len(lo)):
        out[i] = float(np.min(lo[i - n : i]))
    return out


def realised_vol(c: F, n: int, bars_per_year: float) -> F:
    out = _nan(len(c))
    if len(c) <= n or n < 2:
        return out
    lr = np.diff(np.log(c))
    for i in range(n, len(c)):
        out[i] = float(np.std(lr[i - n : i], ddof=1)) * np.sqrt(bars_per_year) * 100.0
    return out


class Bars:
    """Columnar OHLCV arrays for one symbol (bucket start times in epoch ms)."""

    __slots__ = ("c", "h", "lo", "o", "t", "v")

    def __init__(self, t: NDArray[np.int64], o: F, h: F, lo: F, c: F, v: F):
        self.t, self.o, self.h, self.lo, self.c, self.v = t, o, h, lo, c, v

    def __len__(self) -> int:
        return len(self.c)

    def prefix(self, end: int) -> Bars:
        """Bars 0..end-1 (a point-in-time view)."""
        return Bars(
            self.t[:end], self.o[:end], self.h[:end], self.lo[:end], self.c[:end], self.v[:end]
        )


IndicatorFn = Callable[[Bars, int, float], F]


def regime_probability(bars: Bars, regime: str) -> F:
    """Point-in-time regime probability from the goal 07B scanner's regime filter (causal: a
    forward filter on returns up to t). Used by the `ai_regime` condition; NaN while warming up."""
    from ..scanner import detectors  # local import: the scanner imports this module's package
    from ..scanner.panel import Panel, ScanConfig

    n = len(bars)

    def one(a: NDArray[np.float64] | NDArray[np.int64]) -> NDArray[Any]:
        return a.reshape(1, n)

    panel = Panel(
        ["_"],
        one(bars.t.astype(np.int64)),
        one(bars.o),
        one(bars.h),
        one(bars.lo),
        one(bars.c),
        one(bars.v),
        3_600_000,
        np.zeros(1, dtype=np.int64),
        np.zeros(1, dtype=np.int64),
        [np.zeros(0, dtype=np.int64)],
    )
    return np.asarray(
        detectors.regime(panel, ScanConfig())[f"regime_{regime}"][0], dtype=np.float64
    )


# Registry used by the evaluator. Tests may patch an entry to prove the look-ahead guard works.
REGISTRY: dict[str, IndicatorFn] = {
    "close": lambda b, _n, _y: b.c.copy(),
    "open": lambda b, _n, _y: b.o.copy(),
    "high": lambda b, _n, _y: b.h.copy(),
    "low": lambda b, _n, _y: b.lo.copy(),
    "volume": lambda b, _n, _y: b.v.copy(),
    "ema": lambda b, n, _y: ema(b.c, n),
    "sma": lambda b, n, _y: sma(b.c, n),
    "rsi": lambda b, n, _y: rsi(b.c, n),
    "atr": lambda b, n, _y: atr(b.h, b.lo, b.c, n),
    "adx": lambda b, n, _y: adx(b.h, b.lo, b.c, n),
    "roc": lambda b, n, _y: roc(b.c, n),
    "highest": lambda b, n, _y: highest(b.h, n),
    "lowest": lambda b, n, _y: lowest(b.lo, n),
    "realised_vol": lambda b, n, y: realised_vol(b.c, n, y),
    "regime_trending": lambda b, _n, _y: regime_probability(b, "trending"),
    "regime_ranging": lambda b, _n, _y: regime_probability(b, "ranging"),
    "regime_volatile": lambda b, _n, _y: regime_probability(b, "volatile"),
}

PRICE_LIKE = {"close", "open", "high", "low", "ema", "sma", "highest", "lowest"}
OSCILLATORS = {"rsi", "adx"}
