"""Closed-form edge maths: expectancy, stress, full Kelly, risk-of-ruin approximation.

Everything here is in R (multiples of the amount risked on a trade). See docs/quant/monte-carlo.md.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

# Broadie-Glasserman-Kou continuity correction for discrete barriers: -zeta(1/2)/sqrt(2 pi)
BGK_BETA = 0.5826


@dataclass(frozen=True)
class Edge:
    """A discrete per-trade outcome distribution in R, net of costs."""

    outcomes: npt.NDArray[np.float64]
    probs: npt.NDArray[np.float64]

    @property
    def mean(self) -> float:
        return float(np.dot(self.outcomes, self.probs))

    @property
    def min_outcome(self) -> float:
        return float(self.outcomes.min())


def avg_loss_r(fat_tail_prob: float, fat_tail_multiple: float) -> float:
    """Average size of a losing trade in R: 1 R normally, `m` R for a fraction `q` of losses."""
    return 1.0 + fat_tail_prob * (fat_tail_multiple - 1.0)


def gross_expectancy(win_rate: float, avg_win: float, loss: float) -> float:
    return win_rate * avg_win - (1.0 - win_rate) * loss


def stressed_win_rate(win_rate: float, avg_win: float, loss: float, edge_cut: float) -> float:
    """Win rate that cuts the gross expectancy by `edge_cut` (0..1), keeping win and loss sizes.

    With gross expectancy E = pW - (1-p)L, the stressed win rate p' solves p'W - (1-p')L = (1-s)E,
    so p' = ((1-s)E + L) / (W + L). There is nothing to cut when E <= 0.
    """
    e = gross_expectancy(win_rate, avg_win, loss)
    if e <= 0 or edge_cut <= 0:
        return win_rate
    p = ((1.0 - edge_cut) * e + loss) / (avg_win + loss)
    return min(max(p, 0.0), 1.0)


def trade_edge(
    win_rate: float, avg_win: float, cost: float, fat_tail_prob: float, fat_tail_multiple: float
) -> Edge:
    """Outcome distribution net of cost: win, normal loss, fat-tail loss."""
    lose = 1.0 - win_rate
    outcomes = np.array([avg_win - cost, -1.0 - cost, -fat_tail_multiple - cost])
    probs = np.array([win_rate, lose * (1.0 - fat_tail_prob), lose * fat_tail_prob])
    return Edge(outcomes=outcomes, probs=probs)


def empirical_edge(r_outcomes: npt.NDArray[np.float64]) -> Edge:
    n = len(r_outcomes)
    return Edge(outcomes=r_outcomes.astype(np.float64), probs=np.full(n, 1.0 / n))


def full_kelly(edge: Edge) -> float:
    """Fraction of equity to risk per 1 R that maximises E[ln(1 + f·R)] (0 when there is no edge).

    Solved by bisection on the derivative g(f) = E[R / (1 + f·R)], which is strictly decreasing.
    The domain is 0 <= f < 1/|worst outcome| so equity stays positive.
    """
    if edge.mean <= 0:
        return 0.0
    worst = edge.min_outcome
    if worst >= 0:
        return math.inf
    hi = (1.0 / -worst) * (1.0 - 1e-12)
    lo = 0.0

    def g(f: float) -> float:
        return float(np.dot(edge.probs, edge.outcomes / (1.0 + f * edge.outcomes)))

    if g(hi) > 0:  # pragma: no cover - g -> -inf at the domain edge; numerical guard only
        return hi
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if g(mid) > 0:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-12:
            break
    return 0.5 * (lo + hi)


def _norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def risk_of_ruin_fixed_fractional(edge: Edge, fraction: float, floor: float, trades: int) -> float:
    """Closed-form approximation of P(equity touches `floor`·start within `trades` trades).

    Log equity under fixed-fractional sizing is a random walk with per-trade drift
    mu = E[ln(1+fR)] and variance s^2 = Var[ln(1+fR)]. For a Brownian motion with drift started at
    0 and a barrier at -b (b = -ln floor), the first-passage probability by time T is
        Phi((-b - mu T)/(s sqrt T)) + exp(-2 mu b / s^2) Phi((-b + mu T)/(s sqrt T)).
    Trades are discrete, so the barrier is shifted by BGK_BETA·s (Broadie, Glasserman & Kou 1997).
    """
    if floor <= 0:
        return 0.0
    growth = 1.0 + fraction * edge.outcomes
    if np.any(growth <= 0):
        return 1.0
    logs = np.log(growth)
    mu = float(np.dot(edge.probs, logs))
    var = float(np.dot(edge.probs, (logs - mu) ** 2))
    if var <= 0:
        return 1.0 if mu < 0 and -mu * trades >= -math.log(floor) else 0.0
    s = math.sqrt(var)
    b = -math.log(floor) + BGK_BETA * s
    t = float(trades)
    first = _norm_cdf((-b - mu * t) / (s * math.sqrt(t)))
    expo = -2.0 * mu * b / var
    second = (
        0.0
        if expo < -700
        else math.exp(min(expo, 700.0)) * _norm_cdf((-b + mu * t) / (s * math.sqrt(t)))
    )
    return float(min(max(first + second, 0.0), 1.0))
