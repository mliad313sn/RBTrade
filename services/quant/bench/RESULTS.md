# Gain simulator benchmark

- Date: 2026-09-26 13:35 UTC
- Python 3.11.15, numpy 2.4.6, numba 0.67.0
- CPU: x86_64, 4 logical cores (kernel is single-threaded)
- Workload: 10,000 paths x 1,000 trades, fixed-fractional 1%, fat tails 3% at 3R, costs 0.08R; end to end through `service.project` with a cleared cache
- Warm-up (numba compile or cache load): 0.16 s, excluded from timings

| runs | mean | p50 | p95 | max | budget (p95) | result |
|---|---|---|---|---|---|---|
| 30 | 147 ms | 149 ms | 163 ms | 165 ms | 1500 ms | PASS |
