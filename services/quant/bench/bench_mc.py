"""Benchmark: 10,000 paths x 1,000 trades, end to end through `service.project` (goal 05 budget).

Run:  .venv/bin/python bench/bench_mc.py [--runs 30] [--write bench/RESULTS.md]

Each run uses a new seed and a cleared cache, so every run is a real simulation (draws, kernel,
percentiles, histograms, reality checks). The one-off numba compile happens in `warm_up()` before
timing; with `cache=True` it is loaded from disk on later process starts.
"""

from __future__ import annotations

import argparse
import os
import platform
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import numba
import numpy as np

from kora_quant.sim import service
from kora_quant.sim.engine import warm_up
from kora_quant.sim.models import ProjectRequest

BUDGET_S = 1.5


def percentile(xs: list[float], p: float) -> float:
    return float(np.percentile(np.asarray(xs), p))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=30)
    ap.add_argument("--write", type=Path, default=None)
    args = ap.parse_args()

    t0 = time.perf_counter()
    warm_up()
    compile_s = time.perf_counter() - t0

    base = ProjectRequest(
        paths=10_000,
        trades_per_period=50,
        horizon_periods=20,  # 1,000 trades per path
        fat_tail_prob_pct=3,
        cost_per_trade_r=0.08,
    )
    times: list[float] = []
    for i in range(args.runs):
        service.clear_cache()
        t = time.perf_counter()
        r = service.project(base.model_copy(update={"seed": 1_000 + i}))
        times.append(time.perf_counter() - t)
        if (r.trades_per_path, r.paths) != (1_000, 10_000):
            raise RuntimeError("unexpected workload shape")

    p50, p95, worst = percentile(times, 50), percentile(times, 95), max(times)
    ok = p95 < BUDGET_S
    lines = [
        "# Gain simulator benchmark",
        "",
        f"- Date: {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')}",
        f"- Python {platform.python_version()}, numpy {np.__version__}, numba {numba.__version__}",
        f"- CPU: {platform.machine()}, {os.cpu_count()} logical cores (kernel is single-threaded)",
        "- Workload: 10,000 paths x 1,000 trades, fixed-fractional 1%, fat tails 3% at 3R, "
        "costs 0.08R; end to end through `service.project` with a cleared cache",
        f"- Warm-up (numba compile or cache load): {compile_s:.2f} s, excluded from timings",
        "",
        "| runs | mean | p50 | p95 | max | budget (p95) | result |",
        "|---|---|---|---|---|---|---|",
        f"| {len(times)} | {statistics.mean(times) * 1000:.0f} ms | {p50 * 1000:.0f} ms | "
        f"{p95 * 1000:.0f} ms | {worst * 1000:.0f} ms | {BUDGET_S * 1000:.0f} ms | "
        f"{'PASS' if ok else 'FAIL'} |",
        "",
    ]
    text = "\n".join(lines)
    print(text)
    if args.write:
        args.write.write_text(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
