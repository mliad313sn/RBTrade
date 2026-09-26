# Market intelligence scanner benchmark (goal 07B)

- Date: 2026-09-26 20:34 UTC
- Python 3.11.15, numpy 2.4.6, numba 0.67.0
- CPU: x86_64, 4 logical cores (single-threaded)
- Universe: 10,000 SIMULATED synthetic instruments × 500 one-hour bars (5,000,000 bars), 20 features per bar, deterministic seed
- Warm-up (numba compile or cache load): 0.21 s, excluded

| measurement | runs | mean | max | budget | result |
|---|---|---|---|---|---|
| full scan (all detectors, latest features, trend labels) | 3 | 8.60 s | 10.42 s | 60 s | PASS |
| incremental bar close (600-bar window, 10,000 instruments) | 1 | 8.83 s | 8.83 s | 60 s | PASS |
| look-ahead guard, 4 checkpoints, 1,000 instruments | 1 | 1.08 s | 1.08 s | — | info |

Command: `.venv/bin/python bench/bench_scanner.py --write bench/SCANNER_RESULTS.md`. CI guard: `tests/test_scanner_perf.py` (10,000 × 500 < 60 s).
