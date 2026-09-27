"""Point-in-time trend forecasts (goal 07B §3).

For one instrument and one horizon of h bars:

- label y_t = 1 if ln(close_{t+h} / close_t) > 0 (direction), only for t + h inside the data;
- inputs: standardised scanner features at t (computed causally, see detectors.py);
- anchored walk-forward: K contiguous test folds after `min_train` rows; each fold's model is
  trained only on rows whose label window ended before the fold starts (embargo = h bars), so no
  training label overlaps the test period;
- calibration of fold k: isotonic (or Platt) fitted on the out-of-sample scores of folds < k whose
  label window ended before fold k starts (the same h-bar embargo, IRTC R3-12);
- out-of-sample skill after costs: Brier skill vs the training base rate, and the net return of
  following the forecast direction minus the round-trip cost, t-statistic on non-overlapping
  forecasts (every h-th). `has_skill` needs n ≥ 30, Brier skill > 0, mean net > 0 and t ≥ 2;
- the live forecast: a model trained on every labelled row, scored on the latest bar and
  calibrated with every out-of-sample score; drivers are exact linear SHAP values (log-odds).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from numpy.typing import NDArray

from .calibrate import Calibrator, brier, fit_calibrator, fit_logistic, sigmoid

F1 = NDArray[np.float64]
F2 = NDArray[np.float64]

FORECAST_FEATURES = (
    "slope_t",
    "mom_z",
    "mr_z",
    "ret_z",
    "adx",
    "channel_pos",
    "bb_width_pct",
    "vol_ratio",
    "regime_trending",
    "regime_volatile",
    "rs_sector",
    "rs_index",
    "volume_z",
    "season_t",
)


@dataclass(frozen=True)
class ForecastConfig:
    horizon: int
    cost: float = 0.0  # round-trip cost as a fraction of price
    folds: int = 5
    min_train: int = 200
    l2: float = 1.0
    max_nan_share: float = 0.2


@dataclass
class OosPoint:
    t: int  # column index of the forecast bar
    p_up: float
    outcome: bool
    net: float
    method: str


@dataclass
class ForecastResult:
    status: str  # ok | insufficient_data
    features: list[str]
    oos: list[OosPoint] = field(default_factory=list)
    skill: dict[str, Any] = field(default_factory=dict)
    latest: dict[str, Any] | None = None


def _standardise(x: F2, rows: NDArray[np.int64]) -> tuple[F1, F1]:
    mu = x[rows].mean(axis=0)
    sd = x[rows].std(axis=0)
    return mu, np.where(sd > 1e-12, sd, 1.0)


def fold_plan(
    labelled: NDArray[np.int64], min_train: int, folds: int, horizon: int
) -> list[tuple[NDArray[np.int64], NDArray[np.int64]]]:
    """Anchored walk-forward: (train rows, test rows) per fold. A training row t is used only if
    its label window (t, t + horizon] ended before the fold's first bar (embargo)."""
    plan: list[tuple[NDArray[np.int64], NDArray[np.int64]]] = []
    for block in np.array_split(labelled[min_train:], folds):
        if len(block) == 0:
            continue
        start = int(block[0])
        plan.append((labelled[labelled + horizon < start], block))
    return plan


def forecast(x_all: F2, close: F1, names: list[str], cfg: ForecastConfig) -> ForecastResult:
    """`x_all`: bars × features (NaN allowed), `close`: bars. Column index = bar index."""
    n_bars = len(close)
    h = cfg.horizon
    with np.errstate(invalid="ignore", divide="ignore"):
        fwd = np.full(n_bars, np.nan)
        if h < n_bars:
            fwd[: n_bars - h] = np.log(close[h:] / close[: n_bars - h])
    # Drop features that are mostly missing over the usable part (e.g. single-member groups).
    finite_close = np.isfinite(close)
    keep = [
        j
        for j in range(x_all.shape[1])
        if np.mean(~np.isfinite(x_all[finite_close, j])) <= cfg.max_nan_share
        if finite_close.any()
    ]
    feats = [names[j] for j in keep]
    x = x_all[:, keep]
    row_ok = np.asarray(
        np.isfinite(x).all(axis=1) if keep else np.zeros(n_bars, dtype=np.bool_), dtype=np.bool_
    )
    labelled = np.nonzero(row_ok & np.isfinite(fwd))[0]
    res = ForecastResult(status="insufficient_data", features=feats)
    need = cfg.min_train + cfg.folds * max(10, h)
    if not keep or len(labelled) < need:
        res.skill = {"reason": f"{len(labelled)} labelled bars, need {need}", "horizonBars": h}
        return res

    y_all = (fwd > 0).astype(np.float64)
    oos_t: list[int] = []
    oos_raw: list[float] = []
    oos_cal: list[float] = []
    oos_method: list[str] = []
    base_rates: list[float] = []
    for train, block in fold_plan(labelled, cfg.min_train, cfg.folds, h):
        if len(train) < cfg.min_train // 2 or len(np.unique(y_all[train])) < 2:
            continue
        mu, sd = _standardise(x, train)
        w = fit_logistic((x[train] - mu) / sd, y_all[train], cfg.l2)
        raw_b = sigmoid(w[0] + ((x[block] - mu) / sd) @ w[1:])
        # Embargo for the calibrator too: earlier out-of-sample rows whose label window reaches
        # into this fold would leak its outcomes into the calibration (IRTC R3-12).
        prior_t = np.asarray(oos_t, dtype=np.int64)
        ok = prior_t + h < int(block[0])
        cal: Calibrator = fit_calibrator(
            np.asarray(oos_raw, dtype=np.float64)[ok], y_all[prior_t[ok]]
        )
        p = cal.predict(raw_b)
        oos_t.extend(int(t) for t in block)
        oos_raw.extend(float(v) for v in raw_b)
        oos_cal.extend(float(v) for v in p)
        oos_method.extend([cal.method] * len(block))
        base_rates.extend([float(np.mean(y_all[train]))] * len(block))

    if len(oos_t) < 30:
        res.skill = {"reason": "not enough out-of-sample forecasts", "horizonBars": h}
        return res
    t_arr = np.asarray(oos_t, dtype=np.int64)
    p_arr = np.asarray(oos_cal)
    y_oos = y_all[t_arr]
    direction = np.where(p_arr >= 0.5, 1.0, -1.0)
    net = direction * fwd[t_arr] - cfg.cost
    for i in range(len(t_arr)):
        res.oos.append(
            OosPoint(int(t_arr[i]), float(p_arr[i]), bool(net[i] > 0), float(net[i]), oos_method[i])
        )
    # Non-overlapping subsample (every h-th forecast) for the t-statistic.
    picked: list[int] = []
    last = -(10**9)
    for i, t in enumerate(t_arr.tolist()):
        if t - last >= h:
            picked.append(i)
            last = t
    nn = net[np.asarray(picked, dtype=int)]
    mean_net = float(np.mean(nn))
    sd_net = float(np.std(nn, ddof=1)) if len(nn) > 1 else 0.0
    t_stat = mean_net / sd_net * math.sqrt(len(nn)) if sd_net > 0 else 0.0
    b = brier(p_arr, y_oos)
    b0 = brier(np.asarray(base_rates), y_oos)
    bss = 1.0 - b / b0 if b0 > 0 else 0.0
    has_skill = len(nn) >= 30 and bss > 0 and mean_net > 0 and t_stat >= 2.0
    res.status = "ok"
    res.skill = {
        "horizonBars": h,
        "oosForecasts": len(t_arr),
        "nonOverlapping": len(nn),
        "brier": round(b, 6),
        "brierBaseline": round(b0, 6),
        "brierSkill": round(bss, 6),
        "hitRate": round(float(np.mean(net > 0)), 6),
        "meanNetReturn": round(mean_net, 8),
        "tStat": round(t_stat, 4),
        "costFraction": cfg.cost,
        "hasSkill": bool(has_skill),
        "calibration": oos_method[-1],
    }

    # Live forecast on the latest bar (if its features are complete).
    last_t = n_bars - 1
    if not row_ok[last_t]:
        return res
    mu, sd = _standardise(x, labelled)
    w = fit_logistic((x[labelled] - mu) / sd, y_all[labelled], cfg.l2)
    z = (x[last_t] - mu) / sd
    logit_raw = float(w[0] + z @ w[1:])
    raw = float(sigmoid(np.asarray([logit_raw]))[0])
    cal = fit_calibrator(np.asarray(oos_raw), y_all[t_arr])
    p_up = float(cal.predict(np.asarray([raw]))[0])
    phi = w[1:] * z
    order = np.argsort(-np.abs(phi))
    res.latest = {
        "t": last_t,
        "pUpRaw": round(raw, 6),
        "pUp": round(p_up, 6),
        "direction": "up" if p_up >= 0.5 else "down",
        "pDirection": round(max(p_up, 1.0 - p_up), 6),
        "calibration": cal.method,
        "baseLogOdds": round(float(w[0]), 6),
        "drivers": [
            {
                "feature": feats[int(j)],
                "value": round(float(x[last_t, int(j)]), 6),
                "contribution": round(float(phi[int(j)]), 6),
            }
            for j in order[:5]
        ],
    }
    return res
