"""Scanner detectors. Each outputs feature values (floats, NaN while warming up), never prose.

Window lengths come from `ScanConfig` (defaults in brackets):

- `adx`, `atr`: Wilder ADX / ATR [14] (goal 06 conventions).
- `slope_t`: OLS slope t-statistic of log close over the last `fast` [20] bars, capped at ±50.
- `regime_trending` / `regime_ranging` / `regime_volatile`: point-in-time regime probabilities
  (kernels.regime_filter on the return and `mom_z`); they sum to 1.
- `breakout`: +1 if close > highest high of the previous `breakout` [20] bars, −1 if close <
  lowest low, else 0. `channel_pos`: (close − lowest low) / (highest high − lowest low) of the
  same previous bars.
- `bb_width_pct`: percentile rank of the Bollinger width 4·sd/mean (sample sd of `fast` closes)
  among the last `slow` [100] widths. `atr_ratio`: ATR[adx] / mean true range of the last `slow`
  bars (compression < 1).
- `mom_z`: ln(close_t / close_{t−fast}) / (sd of the previous `slow` 1-bar log returns × √fast).
  `mr_z`: (close − mean of `fast` closes) / sample sd of `fast` closes.
- `rs_sector` / `rs_index`: `fast`-bar log return minus the mean of the other instruments in the
  same sector / region at the same bar position.
- `corr_break`: corr(fast) − corr(slow) of 1-bar log returns against the equal-weight mean return
  of the other instruments in the region.
- `volume_z`: (ln(1+v_t) − mean) / sd over the previous `fast` bars (0 when flat).
- `vol_ratio`: sd of the last `fast` returns / sd of the last `slow`. `ret_z`: current return /
  sd of the previous `slow` returns.
- `season_t`: t-stat of the last `season` [20] returns in the next bar's UTC hour.
- `event_minutes`: minutes from the bar's close to the instrument's next scheduled high-impact
  event (NaN if none).

All values at column t use columns 0..t only. The prefix guard in `guard.py` verifies it.
"""

from __future__ import annotations

import math
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from . import kernels as k
from .panel import F2, I1, Panel, ScanConfig

FEATURES = (
    "adx",
    "atr",
    "slope_t",
    "regime_trending",
    "regime_ranging",
    "regime_volatile",
    "breakout",
    "channel_pos",
    "bb_width_pct",
    "atr_ratio",
    "mom_z",
    "mr_z",
    "rs_sector",
    "rs_index",
    "corr_break",
    "volume_z",
    "vol_ratio",
    "ret_z",
    "season_t",
    "event_minutes",
)

Features = dict[str, F2]


def log_returns(c: F2) -> F2:
    r = np.full(c.shape, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r[:, 1:] = np.log(c[:, 1:] / c[:, :-1])
    return r


def _shift(x: F2, lag: int) -> F2:
    out = np.full(x.shape, np.nan)
    if lag < x.shape[1]:
        out[:, lag:] = x[:, : x.shape[1] - lag]
    return out


def group_mean_excl(x: F2, groups: I1) -> F2:
    """Per column, the mean of x over the *other* members of each row's group (NaN if none)."""
    out = np.full(x.shape, np.nan)
    finite = np.isfinite(x)
    vals = np.where(finite, x, 0.0)
    for g in np.unique(groups):
        idx = np.nonzero(groups == g)[0]
        s = vals[idx].sum(axis=0)
        cnt = finite[idx].sum(axis=0)
        m = cnt[None, :] - finite[idx].astype(np.int64)
        out[idx] = np.where(m > 0, (s[None, :] - vals[idx]) / np.maximum(m, 1), np.nan)
    return out


def event_minutes(p: Panel) -> F2:
    out = np.full(p.c.shape, np.nan)
    for i, ev in enumerate(p.events):
        if len(ev) == 0:
            continue
        valid = p.t[i] > 0
        close = p.t[i] + p.tf_ms
        j = np.searchsorted(ev, close, side="left")
        has = valid & (j < len(ev))
        nxt = ev[np.minimum(j, len(ev) - 1)]
        out[i] = np.where(has, (nxt - close) / 60_000.0, np.nan)
    return out


def _momentum(r: F2, logc: F2, cfg: ScanConfig) -> tuple[F2, F2, F2, F2]:
    """(sd of the last `slow` returns incl. t, the same shifted to exclude t, fast-bar log return,
    momentum z-score)."""
    _, sd_incl = k.rolling_mean_std(r, cfg.slow, 1)
    sd_prev = _shift(sd_incl, 1)
    mom = logc - _shift(logc, cfg.fast)
    with np.errstate(invalid="ignore", divide="ignore"):
        mom_z = np.where(sd_prev > 0, mom / (sd_prev * math.sqrt(cfg.fast)), np.nan)
    return sd_incl, sd_prev, mom, mom_z


def _regime(r: F2, mom_z: F2, cfg: ScanConfig) -> Features:
    p_tr, p_rg, p_vo = k.regime_filter(
        r,
        mom_z,
        cfg.slow,
        cfg.regime_vol_mult,
        cfg.regime_stay,
        cfg.regime_trend_t,
        cfg.regime_trend_k,
    )
    return {"regime_trending": p_tr, "regime_ranging": p_rg, "regime_volatile": p_vo}


def regime(p: Panel, cfg: ScanConfig | None = None) -> Features:
    """Only the regime probabilities (the goal 06 `ai_regime` condition reads these)."""
    cfg = cfg or ScanConfig()
    with np.errstate(invalid="ignore", divide="ignore"):
        r = log_returns(p.c)
        logc = np.log(p.c)
    _, _, _, mom_z = _momentum(r, logc, cfg)
    return _regime(r, mom_z, cfg)


def compute(p: Panel, cfg: ScanConfig | None = None) -> Features:
    """Every detector over the whole panel (one array per feature, shape instruments × bars)."""
    cfg = cfg or ScanConfig()
    c, h, lo = p.c, p.h, p.lo
    with np.errstate(invalid="ignore", divide="ignore"):
        r = log_returns(c)
        logc = np.log(c)
    atr, adx = k.adx(h, lo, c, cfg.adx)
    st = k.slope_t(logc, cfg.fast)
    hi_prev = k.prev_extreme(h, cfg.breakout, True)
    lo_prev = k.prev_extreme(lo, cfg.breakout, False)
    with np.errstate(invalid="ignore", divide="ignore"):
        breakout = np.where(
            np.isnan(hi_prev) | np.isnan(c),
            np.nan,
            np.where(c > hi_prev, 1.0, np.where(c < lo_prev, -1.0, 0.0)),
        )
        rng = hi_prev - lo_prev
        channel = np.where(rng > 0, (c - lo_prev) / np.where(rng > 0, rng, 1.0), 0.5)
        channel = np.where(np.isnan(rng) | np.isnan(c), np.nan, channel)
        mean_f, sd_f = k.rolling_mean_std(c, cfg.fast, 1)
        width = np.where(mean_f > 0, 4.0 * sd_f / mean_f, np.nan)
        bb_pct = k.pct_rank(width, cfg.slow)
        tr = h - lo
        prev_c = _shift(c, 1)
        tr = np.where(
            np.isnan(prev_c),
            tr,
            np.maximum(tr, np.maximum(np.abs(h - prev_c), np.abs(lo - prev_c))),
        )
        tr_slow, _ = k.rolling_mean_std(tr, cfg.slow, 0)
        atr_ratio = np.where(tr_slow > 0, atr / tr_slow, np.nan)
        # Return statistics over the previous `slow` bars (current bar excluded).
        sd_r_slow_incl, sd_prev, mom, mom_z = _momentum(r, logc, cfg)
        mr_z = np.where(sd_f > 0, (c - mean_f) / sd_f, np.where(np.isnan(sd_f), np.nan, 0.0))
        rs_sector = mom - group_mean_excl(mom, p.sector)
        rs_index = mom - group_mean_excl(mom, p.region)
        idx_r = group_mean_excl(r, p.region)
        corr_break = k.rolling_corr(r, idx_r, cfg.fast) - k.rolling_corr(r, idx_r, cfg.slow)
        lv = np.log1p(np.where(p.v >= 0, p.v, np.nan))
        mv, sv = k.rolling_mean_std(lv, cfg.fast, 1)
        mv_p, sv_p = _shift(mv, 1), _shift(sv, 1)
        volume_z = np.where(sv_p > 0, (lv - mv_p) / sv_p, np.where(np.isnan(sv_p), np.nan, 0.0))
        _, sd_r_fast = k.rolling_mean_std(r, cfg.fast, 1)
        vol_ratio = np.where(sd_r_slow_incl > 0, sd_r_fast / sd_r_slow_incl, np.nan)
        ret_z = np.where(sd_prev > 0, r / sd_prev, np.nan)
    season = k.seasonality_t(r, p.t, p.tf_ms, cfg.season)
    return {
        "adx": adx,
        "atr": atr,
        "slope_t": st,
        **_regime(r, mom_z, cfg),
        "breakout": breakout,
        "channel_pos": channel,
        "bb_width_pct": bb_pct,
        "atr_ratio": atr_ratio,
        "mom_z": mom_z,
        "mr_z": mr_z,
        "rs_sector": rs_sector,
        "rs_index": rs_index,
        "corr_break": corr_break,
        "volume_z": volume_z,
        "vol_ratio": vol_ratio,
        "ret_z": ret_z,
        "season_t": season,
        "event_minutes": event_minutes(p),
    }


TrendKind = Literal["up", "down", "range", "breakout_up", "breakout_down", "reversal", "vol_regime"]


def _f(x: float) -> float:
    return x if math.isfinite(x) else 0.0


def classify(feat: dict[str, float]) -> tuple[TrendKind, float] | None:
    """Labels the latest bar of one instrument with an emerging-trend kind and a 0–1 score, from
    feature values only (transparent rules; the ranking, not a forecast). None when nothing
    stands out or the features are still warming up."""
    need = ("slope_t", "regime_trending", "regime_volatile", "regime_ranging", "breakout")
    if any(not math.isfinite(feat.get(x, math.nan)) for x in need):
        return None
    st, adx = feat["slope_t"], _f(feat.get("adx", math.nan))
    candidates: list[tuple[TrendKind, float]] = []
    bo = feat["breakout"]
    if bo != 0:
        squeeze = 1.0 - _f(feat.get("bb_width_pct", math.nan))
        score = min(1.0, 0.5 + 0.5 * squeeze)
        candidates.append(("breakout_up" if bo > 0 else "breakout_down", score))
    if feat["regime_volatile"] > 0.6 and _f(feat.get("vol_ratio", math.nan)) > 1.5:
        candidates.append(("vol_regime", min(1.0, feat["regime_volatile"])))
    mom = _f(feat.get("mom_z", math.nan))
    if feat["regime_trending"] > 0.5 and abs(mom) > 1.5 and mom * st > 0:
        score = min(1.0, (abs(mom) / 4.0) * (0.5 + min(adx, 50.0) / 100.0))
        candidates.append(("up" if mom > 0 else "down", score))
    mr = _f(feat.get("mr_z", math.nan))
    if abs(mr) > 2.0 and mom * st < 0:
        candidates.append(("reversal", min(1.0, abs(mr) / 4.0)))
    if feat["regime_ranging"] > 0.6 and abs(st) < 1.0:
        candidates.append(("range", min(1.0, feat["regime_ranging"] * 0.8)))
    if not candidates:
        return None
    kind, score = max(candidates, key=lambda x: x[1])
    return kind, round(score, 4)


def last_column(feats: Features) -> list[dict[str, float]]:
    """Per instrument, the latest bar's value of every feature."""
    n = next(iter(feats.values())).shape[0] if feats else 0
    return [{name: float(arr[i, -1]) for name, arr in feats.items()} for i in range(n)]


def as_wire(x: float, digits: int = 6) -> float | None:
    return round(x, digits) if math.isfinite(x) else None


def matrix(feats: Features, names: tuple[str, ...], i: int) -> NDArray[np.float64]:
    """Bars × features matrix for one instrument (forecast inputs)."""
    return np.stack([feats[n][i] for n in names], axis=1)
