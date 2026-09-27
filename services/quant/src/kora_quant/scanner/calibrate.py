"""Probability calibration (goal 07B §3): isotonic regression (pool-adjacent-violators) and Platt
scaling, plus the L2 logistic regression used by the trend forecasts. Plain numpy, deterministic.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import NDArray

F1 = NDArray[np.float64]
F2 = NDArray[np.float64]
EPS = 1e-6
# Bounds of any calibrated probability (IRTC R3-09): 1 % either side.
P_MIN = 0.01


def sigmoid(z: F1) -> F1:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35.0, 35.0)))


def logit(p: F1) -> F1:
    q = np.clip(p, EPS, 1.0 - EPS)
    return np.log(q / (1.0 - q))


def fit_logistic(x: F2, y: F1, l2: float = 1.0, iters: int = 50) -> F1:
    """Newton/IRLS for L2-penalised logistic regression. Returns [intercept, w...]; the intercept
    is not penalised."""
    n, d = x.shape
    xb = np.hstack([np.ones((n, 1)), x])
    w = np.zeros(d + 1)
    pen = np.full(d + 1, l2)
    pen[0] = 0.0
    for _ in range(iters):
        p = sigmoid(xb @ w)
        grad = xb.T @ (y - p) - pen * w
        hess = (xb * (p * (1.0 - p))[:, None]).T @ xb + np.diag(pen + 1e-9)
        step = np.linalg.solve(hess, grad)
        w = w + step
        if float(np.max(np.abs(step))) < 1e-8:
            break
    return w


@dataclass(frozen=True)
class Isotonic:
    """Step function from PAV: `upper[k]` is the largest score of block k, `value[k]` its mean."""

    upper: F1
    value: F1
    weight: F1 | None = None  # points pooled in each block

    def _index(self, s: F1) -> NDArray[np.intp]:
        return np.clip(np.searchsorted(self.upper, s, side="left"), 0, len(self.value) - 1)

    def predict(self, s: F1) -> F1:
        return np.asarray(self.value[self._index(s)], dtype=np.float64)

    def predict_smoothed(self, s: F1) -> F1:
        """Block means with one pseudo-success and one pseudo-failure (Laplace / Beta(1, 1)):
        never exactly 0 or 1, and small blocks shrink towards 1/2 (IRTC R3-09: on no-skill random
        walks the raw step function said 1.0 for 2 % of forecasts)."""
        if self.weight is None:
            return self.predict(s)
        i = self._index(s)
        w = self.weight[i]
        return np.asarray((self.value[i] * w + 1.0) / (w + 2.0), dtype=np.float64)


def fit_isotonic(s: F1, y: F1) -> Isotonic:
    """Non-decreasing least-squares fit of y on s (pool adjacent violators)."""
    order = np.argsort(s, kind="stable")
    xs, ys = s[order], y[order].astype(np.float64)
    vals: list[float] = []
    weights: list[float] = []
    uppers: list[float] = []
    for x, v in zip(xs.tolist(), ys.tolist(), strict=True):
        vals.append(v)
        weights.append(1.0)
        uppers.append(x)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            w = weights[-2] + weights[-1]
            m = (vals[-2] * weights[-2] + vals[-1] * weights[-1]) / w
            vals[-2:] = [m]
            weights[-2:] = [w]
            uppers[-2:] = [uppers[-1]]
    return Isotonic(np.asarray(uppers), np.asarray(vals), np.asarray(weights))


@dataclass(frozen=True)
class Platt:
    a: float
    b: float

    def predict(self, s: F1) -> F1:
        return sigmoid(self.a * logit(s) + self.b)


def fit_platt(s: F1, y: F1) -> Platt:
    w = fit_logistic(logit(s)[:, None], y, l2=1e-3)
    return Platt(float(w[1]), float(w[0]))


Method = Literal["isotonic", "platt", "none"]


@dataclass(frozen=True)
class Calibrator:
    method: Method
    iso: Isotonic | None = None
    platt: Platt | None = None

    def predict(self, s: F1) -> F1:
        """Calibrated probabilities, bounded to [P_MIN, 1 − P_MIN] whatever the method (IRTC
        R3-09): an out-of-sample forecast is never shown as certain."""
        if self.iso is not None:
            p = self.iso.predict_smoothed(s)
        elif self.platt is not None:
            p = self.platt.predict(s)
        else:
            p = s
        return np.clip(np.asarray(p, dtype=np.float64), P_MIN, 1.0 - P_MIN)


def fit_calibrator(s: F1, y: F1, min_isotonic: int = 200, min_platt: int = 30) -> Calibrator:
    """Isotonic with enough out-of-sample points, Platt with fewer, identity with almost none."""
    if len(s) >= min_isotonic:
        return Calibrator("isotonic", iso=fit_isotonic(s, y))
    if len(s) >= min_platt and 0 < float(np.mean(y)) < 1:
        return Calibrator("platt", platt=fit_platt(s, y))
    return Calibrator("none")


def brier(p: F1, y: F1) -> float:
    return float(np.mean((p - y) ** 2)) if len(p) else math.nan
