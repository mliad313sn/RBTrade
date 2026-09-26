"""Performance guard: 10k paths x 1,000 trades p95 < 1.5 s (full benchmark: bench/bench_mc.py)."""

from __future__ import annotations

import time

import numpy as np

from kora_quant.sim import service
from kora_quant.sim.engine import warm_up
from kora_quant.sim.models import ProjectRequest


def test_10k_paths_by_1000_trades_p95_under_budget() -> None:
    warm_up()
    base = ProjectRequest(paths=10_000, trades_per_period=50, horizon_periods=20)
    times = []
    for seed in range(10):
        service.clear_cache()
        t = time.perf_counter()
        service.project(base.model_copy(update={"seed": seed}))
        times.append(time.perf_counter() - t)
    assert float(np.percentile(times, 95)) < 1.5
