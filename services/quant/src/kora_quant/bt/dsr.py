"""Probabilistic and deflated Sharpe ratios (Bailey & López de Prado).

- PSR(SR*) = Φ( (SR − SR*) √(T − 1) / √(1 − γ₃ SR + (γ₄ − 1)/4 SR²) ), with SR the per-period
  (non-annualised) Sharpe ratio estimated from T observations, γ₃ the skewness and γ₄ the (Pearson,
  non-excess) kurtosis of the returns. ("The Sharpe Ratio Efficient Frontier", 2012.)
- Expected maximum Sharpe ratio after N independent trials with cross-trial variance V[SR]:
  SR₀ = √V[SR] ((1 − γ) Φ⁻¹(1 − 1/N) + γ Φ⁻¹(1 − 1/(N e))), γ ≈ 0.5772 (Euler–Mascheroni).
- DSR = PSR(SR₀). ("The Deflated Sharpe Ratio", 2014.)

Only the standard library's NormalDist is needed (no scipy).
"""

from __future__ import annotations

import math
from statistics import NormalDist

EULER_GAMMA = 0.5772156649015329
_N = NormalDist()


def expected_max_sharpe(var_sr: float, n_trials: int) -> float:
    if n_trials <= 1 or var_sr <= 0:
        return 0.0
    a = _N.inv_cdf(1.0 - 1.0 / n_trials)
    b = _N.inv_cdf(1.0 - 1.0 / (n_trials * math.e))
    return math.sqrt(var_sr) * ((1.0 - EULER_GAMMA) * a + EULER_GAMMA * b)


def probabilistic_sharpe(
    sr: float, sr_benchmark: float, n_obs: int, skew: float, kurtosis: float
) -> float | None:
    if n_obs < 2 or not all(math.isfinite(x) for x in (sr, sr_benchmark, skew, kurtosis)):
        return None
    denom = 1.0 - skew * sr + (kurtosis - 1.0) / 4.0 * sr * sr
    if denom <= 0:
        return None
    z = (sr - sr_benchmark) * math.sqrt(n_obs - 1) / math.sqrt(denom)
    return _N.cdf(z)


def deflated_sharpe(
    sr: float, n_obs: int, skew: float, kurtosis: float, n_trials: int, var_trials: float
) -> tuple[float | None, float]:
    """Returns (DSR, SR₀). With a single trial this is the PSR against zero."""
    sr0 = expected_max_sharpe(var_trials, n_trials)
    return probabilistic_sharpe(sr, sr0, n_obs, skew, kurtosis), sr0
