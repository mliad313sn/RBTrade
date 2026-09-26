"""numba kernels over the panel: each loops over time for one instrument (row) and writes NaN
until its window is complete. Every value at column t uses columns 0..t only (causal); the scan's
look-ahead guard (`guard.verify_scan_point_in_time`) checks this on every test run.

Rows may start with NaN padding (instruments with shorter histories); a window that contains a
NaN yields NaN. Kernels are compiled once (`cache=True`) and warmed up by `warm_up()`.
"""

from __future__ import annotations

import math

import numpy as np
from numba import njit
from numpy.typing import NDArray

F2 = NDArray[np.float64]
I2 = NDArray[np.int64]


@njit(cache=True, nogil=True)
def rolling_mean_std(x: F2, n: int, ddof: int) -> tuple[F2, F2]:
    """Mean and standard deviation of x[t-n+1..t] (direct per-window sums, exact)."""
    rows, cols = x.shape
    mean = np.full((rows, cols), np.nan)
    sd = np.full((rows, cols), np.nan)
    for i in range(rows):
        for t in range(n - 1, cols):
            s = 0.0
            ok = True
            for k in range(t - n + 1, t + 1):
                v = x[i, k]
                if math.isnan(v):
                    ok = False
                    break
                s += v
            if not ok:
                continue
            m = s / n
            ss = 0.0
            for k in range(t - n + 1, t + 1):
                d = x[i, k] - m
                ss += d * d
            mean[i, t] = m
            if n - ddof > 0:
                sd[i, t] = math.sqrt(ss / (n - ddof))
    return mean, sd


@njit(cache=True, nogil=True)
def prev_extreme(x: F2, n: int, want_max: bool) -> F2:
    """Max (or min) of the previous n values x[t-n..t-1], excluding the current bar."""
    rows, cols = x.shape
    out = np.full((rows, cols), np.nan)
    for i in range(rows):
        for t in range(n, cols):
            best = x[i, t - n]
            ok = not math.isnan(best)
            for k in range(t - n + 1, t):
                v = x[i, k]
                if math.isnan(v):
                    ok = False
                    break
                if (want_max and v > best) or ((not want_max) and v < best):
                    best = v
            if ok:
                out[i, t] = best
    return out


@njit(cache=True, nogil=True)
def pct_rank(x: F2, n: int) -> F2:
    """Share of the trailing n values (current included) that are <= the current value."""
    rows, cols = x.shape
    out = np.full((rows, cols), np.nan)
    for i in range(rows):
        for t in range(n - 1, cols):
            cur = x[i, t]
            if math.isnan(cur):
                continue
            le = 0
            ok = True
            for k in range(t - n + 1, t + 1):
                v = x[i, k]
                if math.isnan(v):
                    ok = False
                    break
                if v <= cur:
                    le += 1
            if ok:
                out[i, t] = le / n
    return out


@njit(cache=True, nogil=True)
def slope_t(y: F2, n: int) -> F2:
    """OLS slope t-statistic of y over x = 0..n-1 in the window ending at t (capped at ±50)."""
    rows, cols = y.shape
    out = np.full((rows, cols), np.nan)
    xbar = (n - 1) / 2.0
    sxx = 0.0
    for k in range(n):
        sxx += (k - xbar) ** 2
    for i in range(rows):
        for t in range(n - 1, cols):
            s = 0.0
            ok = True
            for k in range(n):
                v = y[i, t - n + 1 + k]
                if math.isnan(v):
                    ok = False
                    break
                s += v
            if not ok:
                continue
            ybar = s / n
            sxy = 0.0
            for k in range(n):
                sxy += (k - xbar) * (y[i, t - n + 1 + k] - ybar)
            b = sxy / sxx
            a = ybar - b * xbar
            sse = 0.0
            for k in range(n):
                e = y[i, t - n + 1 + k] - (a + b * k)
                sse += e * e
            se = math.sqrt(sse / (n - 2) / sxx) if n > 2 else 0.0
            if se <= 1e-15:
                out[i, t] = 0.0 if abs(b) <= 1e-15 else (50.0 if b > 0 else -50.0)
            else:
                out[i, t] = max(-50.0, min(50.0, b / se))
    return out


@njit(cache=True, nogil=True)
def adx(h: F2, lo: F2, c: F2, n: int) -> tuple[F2, F2]:
    """Wilder ATR and ADX (same conventions as goal 06 `bt.indicators`), per row from its first
    valid bar. Returns (atr, adx)."""
    rows, cols = c.shape
    atr_o = np.full((rows, cols), np.nan)
    adx_o = np.full((rows, cols), np.nan)
    tr = np.zeros(cols)
    up = np.zeros(cols)
    dn = np.zeros(cols)
    dx = np.zeros(cols)
    for i in range(rows):
        s0 = 0
        while s0 < cols and math.isnan(c[i, s0]):
            s0 += 1
        m = cols - s0
        if m < n:
            continue
        for k in range(m):
            j = s0 + k
            hl = h[i, j] - lo[i, j]
            if k == 0:
                tr[k] = hl
                up[k] = 0.0
                dn[k] = 0.0
            else:
                pc = c[i, j - 1]
                tr[k] = max(hl, abs(h[i, j] - pc), abs(lo[i, j] - pc))
                um = h[i, j] - h[i, j - 1]
                dm = lo[i, j - 1] - lo[i, j]
                up[k] = um if (um > dm and um > 0) else 0.0
                dn[k] = dm if (dm > um and dm > 0) else 0.0
        # ATR: mean of TR over bars 0..n-1, then Wilder.
        prev = 0.0
        for k in range(n):
            prev += tr[k]
        prev /= n
        atr_o[i, s0 + n - 1] = prev
        for k in range(n, m):
            prev = (prev * (n - 1) + tr[k]) / n
            atr_o[i, s0 + k] = prev
        if m < n + 1:
            continue
        s_tr = 0.0
        s_up = 0.0
        s_dn = 0.0
        for k in range(1, n + 1):
            s_tr += tr[k]
            s_up += up[k]
            s_dn += dn[k]
        for k in range(m):
            dx[k] = 0.0
        for k in range(n, m):
            if k > n:
                s_tr = s_tr - s_tr / n + tr[k]
                s_up = s_up - s_up / n + up[k]
                s_dn = s_dn - s_dn / n + dn[k]
            if s_tr <= 0:
                dx[k] = 0.0
                continue
            pdi = 100.0 * s_up / s_tr
            mdi = 100.0 * s_dn / s_tr
            dx[k] = 0.0 if pdi + mdi == 0 else 100.0 * abs(pdi - mdi) / (pdi + mdi)
        first = 2 * n - 1
        if m <= first:
            continue
        prev = 0.0
        for k in range(n, 2 * n):
            prev += dx[k]
        prev /= n
        adx_o[i, s0 + first] = prev
        for k in range(first + 1, m):
            prev = (prev * (n - 1) + dx[k]) / n
            adx_o[i, s0 + k] = prev
    return atr_o, adx_o


@njit(cache=True, nogil=True)
def rolling_corr(a: F2, b: F2, n: int) -> F2:
    """Pearson correlation of a and b over the window ending at t (NaN if either is flat)."""
    rows, cols = a.shape
    out = np.full((rows, cols), np.nan)
    for i in range(rows):
        for t in range(n - 1, cols):
            sa = 0.0
            sb = 0.0
            ok = True
            for k in range(t - n + 1, t + 1):
                x = a[i, k]
                y = b[i, k]
                if math.isnan(x) or math.isnan(y):
                    ok = False
                    break
                sa += x
                sb += y
            if not ok:
                continue
            ma = sa / n
            mb = sb / n
            cov = 0.0
            va = 0.0
            vb = 0.0
            for k in range(t - n + 1, t + 1):
                da = a[i, k] - ma
                db = b[i, k] - mb
                cov += da * db
                va += da * da
                vb += db * db
            if va > 0 and vb > 0:
                out[i, t] = cov / math.sqrt(va * vb)
    return out


@njit(cache=True, nogil=True)
def regime_filter(
    r: F2, mz: F2, base_n: int, vol_mult: float, stay: float, trend_t: float, trend_k: float
) -> tuple[F2, F2, F2]:
    """Point-in-time regime probabilities (trending, ranging, volatile).

    Volatility clustering: a two-state Markov-switching filter on the bar return r_t with a calm
    state N(0, σ²) and a volatile state N(0, (vol_mult·σ)²), where σ² is the mean squared return
    of the previous `base_n` bars (the current bar excluded). The forward (filtered) posterior uses
    returns up to t only. Trend: P(trending | calm) = logistic(trend_k · (|mz| − trend_t)) where mz
    is the momentum z-score (N(0, 1) under a random walk, unlike a slope t-statistic of prices).
    """
    rows, cols = r.shape
    p_tr = np.full((rows, cols), np.nan)
    p_rg = np.full((rows, cols), np.nan)
    p_vo = np.full((rows, cols), np.nan)
    sw = 1.0 - stay
    for i in range(rows):
        post_v = 0.5
        started = False
        for t in range(base_n, cols):
            x = r[i, t]
            s2 = 0.0
            ok = not math.isnan(x)
            if ok:
                for k in range(t - base_n, t):
                    v = r[i, k]
                    if math.isnan(v):
                        ok = False
                        break
                    s2 += v * v
            if not ok:
                started = False
                post_v = 0.5
                continue
            s2 /= base_n
            if s2 <= 0:
                s2 = 1e-18
            prior_v = post_v * stay + (1.0 - post_v) * sw if started else 0.5
            sc = math.sqrt(s2)
            sv = sc * vol_mult
            lc = math.exp(-0.5 * (x / sc) ** 2) / sc
            lv = math.exp(-0.5 * (x / sv) ** 2) / sv
            num = prior_v * lv
            den = num + (1.0 - prior_v) * lc
            post_v = num / den if den > 0 else prior_v
            started = True
            s = mz[i, t]
            ptr = 0.5 if math.isnan(s) else 1.0 / (1.0 + math.exp(-trend_k * (abs(s) - trend_t)))
            p_vo[i, t] = post_v
            p_tr[i, t] = (1.0 - post_v) * ptr
            p_rg[i, t] = (1.0 - post_v) * (1.0 - ptr)
    return p_tr, p_rg, p_vo


@njit(cache=True, nogil=True)
def seasonality_t(r: F2, t_ms: I2, tf_ms: int, k: int) -> F2:
    """t-statistic of the last k returns (strictly before t) that fell in the same UTC hour of day
    as the *next* bar (t + tf: its start time is known in advance). NaN until k samples exist."""
    rows, cols = r.shape
    out = np.full((rows, cols), np.nan)
    hour_ms = 3_600_000
    buf = np.zeros((24, k))
    for i in range(rows):
        cnt = np.zeros(24, dtype=np.int64)
        for t in range(cols):
            x = r[i, t]
            if t_ms[i, t] == 0 or math.isnan(x):
                continue
            hn = ((t_ms[i, t] + tf_ms) // hour_ms) % 24
            m = min(cnt[hn], k)
            if m >= k and k > 1:
                s = 0.0
                for j in range(k):
                    s += buf[hn, j]
                mean = s / k
                ss = 0.0
                for j in range(k):
                    ss += (buf[hn, j] - mean) ** 2
                sd = math.sqrt(ss / (k - 1))
                out[i, t] = 0.0 if sd <= 0 else mean / (sd / math.sqrt(k))
            h = (t_ms[i, t] // hour_ms) % 24
            buf[h, cnt[h] % k] = x
            cnt[h] += 1
    return out


def warm_up() -> None:
    """Compiles (or loads from cache) every kernel on a tiny panel."""
    x = np.ones((1, 8)) + np.arange(8, dtype=np.float64) * 0.01
    rolling_mean_std(x, 3, 1)
    prev_extreme(x, 3, True)
    pct_rank(x, 3)
    slope_t(x, 3)
    adx(x + 0.1, x - 0.1, x, 2)
    rolling_corr(x, x, 3)
    regime_filter(x, x, 3, 2.5, 0.97, 2.0, 1.5)
    seasonality_t(x, np.arange(1, 9, dtype=np.int64).reshape(1, 8) * 3_600_000, 3_600_000, 2)
