"""Benchmark: the goal 07B scanner over 10,000 instruments of one-hour bars (budget < 60 s).

Run:  .venv/bin/python bench/bench_scanner.py [--runs 3] [--bars 500]
      [--write bench/SCANNER_RESULTS.md]

The universe is a deterministic SIMULATED synthetic panel (`scanner.synthetic.universe`: geometric
random walks with switching volatility, 5 regions × 13 asset classes × 11 sectors, labelled
`SIM00000`…); nothing here is market data and nothing enters the instrument registry.

Timed: every detector (`detectors.compute`), the latest-bar extraction and the emerging-trend
labels, i.e. one full scan of the universe. Also timed: one incremental bar-close scan
(`ScanState.on_bar_close`, 600-bar window) and the look-ahead guard at 4 checkpoints on a
1,000-instrument slice (the guard re-runs the scan on prefixes, so it is a verification cost, not
part of the scan).
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

from kora_quant.scanner import detectors, kernels, synthetic
from kora_quant.scanner.guard import verify_scan_point_in_time
from kora_quant.scanner.incremental import NewBar, ScanState
from kora_quant.scanner.panel import Panel, ScanConfig

BUDGET_S = 60.0
N = 10_000


def scan_once(p: Panel) -> float:
    t = time.perf_counter()
    rows = detectors.last_column(detectors.compute(p))
    [detectors.classify(r) for r in rows]
    return time.perf_counter() - t


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--bars", type=int, default=500)
    ap.add_argument("--write", type=Path, default=None)
    args = ap.parse_args()

    t0 = time.perf_counter()
    kernels.warm_up()
    compile_s = time.perf_counter() - t0
    p, _, _ = synthetic.universe(N, args.bars + 1, seed=1)
    full = p.prefix(args.bars)
    times = [scan_once(full) for _ in range(args.runs)]

    state = ScanState(full, ScanConfig(), window=600)
    last = p.width - 1
    bars = {
        i: NewBar(
            int(p.t[i, last]),
            float(p.o[i, last]),
            float(p.h[i, last]),
            float(p.lo[i, last]),
            float(p.c[i, last]),
            float(p.v[i, last]),
        )
        for i in range(N)
    }
    t = time.perf_counter()
    state.on_bar_close(bars)
    incr_s = time.perf_counter() - t

    sl, _, _ = synthetic.universe(1_000, args.bars, seed=2)
    feats = detectors.compute(sl)
    t = time.perf_counter()
    verify_scan_point_in_time(sl, ScanConfig(), feats, checkpoints=4)
    guard_s = time.perf_counter() - t

    worst = max(times)
    ok = worst < BUDGET_S
    lines = [
        "# Market intelligence scanner benchmark (goal 07B)",
        "",
        f"- Date: {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')} UTC",
        f"- Python {platform.python_version()}, numpy {np.__version__}, numba {numba.__version__}",
        f"- CPU: {platform.machine()}, {os.cpu_count()} logical cores (single-threaded)",
        f"- Universe: {N:,} SIMULATED synthetic instruments × {args.bars} one-hour bars "
        f"({N * args.bars:,} bars), 20 features per bar, deterministic seed",
        f"- Warm-up (numba compile or cache load): {compile_s:.2f} s, excluded",
        "",
        "| measurement | runs | mean | max | budget | result |",
        "|---|---|---|---|---|---|",
        f"| full scan (all detectors, latest features, trend labels) | {args.runs} | "
        f"{statistics.mean(times):.2f} s | {worst:.2f} s | {BUDGET_S:.0f} s | "
        f"{'PASS' if ok else 'FAIL'} |",
        f"| incremental bar close (600-bar window, {N:,} instruments) | 1 | {incr_s:.2f} s | "
        f"{incr_s:.2f} s | {BUDGET_S:.0f} s | {'PASS' if incr_s < BUDGET_S else 'FAIL'} |",
        f"| look-ahead guard, 4 checkpoints, 1,000 instruments | 1 | {guard_s:.2f} s | "
        f"{guard_s:.2f} s | — | info |",
        "",
        "Command: `.venv/bin/python bench/bench_scanner.py --write bench/SCANNER_RESULTS.md`. "
        "CI guard: `tests/test_scanner_perf.py` (10,000 × 500 < 60 s).",
    ]
    text = "\n".join(lines) + "\n"
    sys.stdout.write(text)
    if args.write:
        args.write.write_text(text)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
