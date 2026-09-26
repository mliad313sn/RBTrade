"""The compiled numba kernels agree with their pure-Python source (also gives line coverage)."""

from __future__ import annotations

import numpy as np
import pytest

from kora_quant.sim import engine
from kora_quant.sim.cache import LruCache


def _run(
    kernel_account: object, kernel_outcomes: object, mode: int, size: float
) -> tuple[np.ndarray, ...]:
    rng = np.random.Generator(np.random.PCG64(123))
    u = rng.random((64, 40))
    r = kernel_outcomes(u, 0.45, 1.8, 0.08, 0.1, 3.0)  # type: ignore[operator]
    eq = np.empty((64, 5))
    dd = np.empty(64)
    uw = np.empty(64, dtype=np.int64)
    st = np.empty(64, dtype=np.int64)
    ru = np.empty(64, dtype=np.bool_)
    w = np.array([0.0, 50.0, 0.0, 500.0])
    kernel_account(r, mode, size, 1_000.0, 700.0, 10, w, eq, dd, uw, st, ru, 0)  # type: ignore[operator]
    return r, eq, dd, uw, st, ru


@pytest.mark.parametrize(
    ("mode", "size"), [(engine.MODE_FRACTION, 0.05), (engine.MODE_AMOUNT, 40.0)]
)
def test_jit_matches_python(mode: int, size: float) -> None:
    jit = _run(engine.account_paths, engine.outcomes_from_uniforms, mode, size)
    py = _run(engine.account_paths.py_func, engine.outcomes_from_uniforms.py_func, mode, size)
    for a, b in zip(jit, py, strict=True):
        np.testing.assert_allclose(a, b, rtol=0, atol=1e-9)
    _, eq, dd, _, _, ruined = py
    assert ruined.any()  # the aggressive sizes hit the 70% floor on some paths
    assert (eq >= 0).all()
    assert (dd >= 0).all()
    assert (dd <= 1).all()


def test_outcomes_all_losses_when_win_rate_zero() -> None:
    u = np.linspace(0, 0.999, 50).reshape(5, 10)
    out = engine.outcomes_from_uniforms.py_func(u, 0.0, 2.0, 0.0, 0.0, 3.0)
    assert (out == -1.0).all()


def test_withdrawal_schedule_ignores_out_of_range_periods() -> None:
    w = engine.withdrawal_schedule(3, 10.0, [(2, 5.0), (9, 100.0)])
    assert list(w) == [10.0, 15.0, 10.0]


def test_histogram_degenerate_values() -> None:
    h = engine.histogram(np.full(10, 5.0))
    assert sum(h.counts) == 10


def test_lru_cache_evicts_oldest() -> None:
    c: LruCache[int] = LruCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("a") == 1
    c.put("c", 3)
    assert c.get("b") is None
    assert len(c) == 2
    with pytest.raises(ValueError, match="capacity"):
        LruCache(0)
