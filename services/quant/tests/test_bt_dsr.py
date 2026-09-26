"""Acceptance: the deflated Sharpe ratio matches the reference values of Bailey & López de Prado."""

from __future__ import annotations

import math

import numpy as np
import pytest

from kora_quant.bt.dsr import deflated_sharpe, expected_max_sharpe, probabilistic_sharpe


def test_dsr_paper_numerical_example() -> None:
    """'The Deflated Sharpe Ratio' (2014), §3 example: annualised SR 2.5 over 5 years of daily data
    (T = 1,250, 250 days a year), skew −3, kurtosis 10, N = 100 trials with annualised variance 0.5.
    The paper reports SR₀ ≈ 0.1132 (non-annualised) and DSR ≈ 0.9004."""
    sr = 2.5 / math.sqrt(250)
    var = 0.5 / 250
    dsr, sr0 = deflated_sharpe(sr, 1250, -3.0, 10.0, 100, var)
    assert sr0 == pytest.approx(0.1132, abs=5e-5)
    assert dsr == pytest.approx(0.9004, abs=5e-5)


def test_expected_max_sharpe_matches_monte_carlo() -> None:
    """E[max of N standard normal draws] × σ: the paper's approximation is within 2 % for N ≥ 100
    (it slightly overstates the maximum for small N, which deflates more, the conservative side)."""
    rng = np.random.default_rng(3)
    for n, tol in ((10, 0.04), (100, 0.02), (1000, 0.02)):
        draws = rng.standard_normal((4000, n)).max(axis=1).mean()
        assert expected_max_sharpe(1.0, n) == pytest.approx(draws, rel=tol)
        assert expected_max_sharpe(1.0, n) >= draws * 0.99
    assert expected_max_sharpe(0.04, 1) == 0.0
    assert expected_max_sharpe(0.0, 50) == 0.0


def test_psr_properties() -> None:
    assert probabilistic_sharpe(0.1, 0.1, 500, 0.0, 3.0) == pytest.approx(0.5)
    # Normal returns: PSR = Φ(SR √(T−1) / √(1 + SR²/2)).
    sr, t = 0.1, 253
    expected = 0.5 * (
        1 + math.erf(sr * math.sqrt(t - 1) / math.sqrt(1 + sr * sr / 2) / math.sqrt(2))
    )
    assert probabilistic_sharpe(sr, 0.0, t, 0.0, 3.0) == pytest.approx(expected)
    # Negative skew and fat tails lower confidence in a positive Sharpe.
    fat = probabilistic_sharpe(0.1, 0.0, 253, -2.0, 9.0)
    normal = probabilistic_sharpe(0.1, 0.0, 253, 0.0, 3.0)
    assert fat is not None and normal is not None and fat < normal
    assert probabilistic_sharpe(0.1, 0.0, 1, 0.0, 3.0) is None
    assert probabilistic_sharpe(3.0, 0.0, 100, 5.0, 3.0) is None  # invalid denominator
    assert probabilistic_sharpe(float("nan"), 0.0, 100, 0.0, 3.0) is None


def test_more_trials_deflate_more() -> None:
    a, _ = deflated_sharpe(0.08, 750, 0.0, 3.0, 1, 0.001)
    b, _ = deflated_sharpe(0.08, 750, 0.0, 3.0, 50, 0.001)
    c, _ = deflated_sharpe(0.08, 750, 0.0, 3.0, 500, 0.001)
    assert a is not None and b is not None and c is not None
    assert a > b > c
