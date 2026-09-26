"""Performance guard: 10,000 instruments × 500 one-hour bars scanned in < 60 s (acceptance, goal
07B). Full benchmark with timings: bench/bench_scanner.py → bench/SCANNER_RESULTS.md."""

from __future__ import annotations

import time

from kora_quant.scanner import detectors, kernels, synthetic


def test_10k_instruments_by_1h_bars_under_60_seconds() -> None:
    kernels.warm_up()
    p, _, _ = synthetic.universe(10_000, 500, seed=1)
    t = time.perf_counter()
    feats = detectors.compute(p)
    rows = detectors.last_column(feats)
    trends = [detectors.classify(r) for r in rows]
    elapsed = time.perf_counter() - t
    assert len(rows) == 10_000
    assert any(x is not None for x in trends)
    assert elapsed < 60.0
