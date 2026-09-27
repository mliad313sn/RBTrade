"""IRTC R3 scanner regressions (SIMULATED random walks only).

- R3-03: replayed out-of-sample forecasts sit on a fixed calendar grid (multiples of the horizon),
  so consecutive hourly scans produce the same prediction times (idempotent inserts) instead of a
  new overlapping phase per scan.
"""

from __future__ import annotations

import itertools
from typing import Any

import numpy as np

from kora_quant.scanner.service import ScanRequest, run_scan

H = 3_600_000
T0 = 1_767_571_200_000  # 2026-01-05T00:00:00Z


def _wire(ts: np.ndarray, c: np.ndarray) -> dict[str, Any]:
    o = np.r_[c[0], c[:-1]]
    return {
        "t": [int(x) for x in ts],
        "o": [float(x) for x in o],
        "h": [float(x) for x in np.maximum(o, c) * 1.0005],
        "l": [float(x) for x in np.minimum(o, c) * 0.9995],
        "c": [float(x) for x in c],
        "v": [1.0] * len(c),
    }


def _walks(n: int, k: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    common = rng.standard_normal(n) * 0.004
    return np.stack(
        [100 * np.exp(np.cumsum(common + rng.standard_normal(n) * 0.004)) for _ in range(k)]
    )


def _scan(closes: np.ndarray, ts: np.ndarray, width: int, **extra: Any) -> dict[str, Any]:
    return run_scan(
        ScanRequest.model_validate(
            {
                "timeframe": "1h",
                "tfSeconds": 3600,
                "width": width,
                "guard": False,
                "instruments": [
                    {"symbol": f"S{i}", "sector": "x", "region": "R", "bars": _wire(ts, c)}
                    for i, c in enumerate(closes)
                ],
                "forecast": {"horizons": [{"label": "1d", "bars": 24}], "minTrain": 200},
                **extra,
            }
        )
    )


def _replay_times(out: dict[str, Any]) -> dict[str, list[int]]:
    return {it["symbol"]: [o["ts"] for o in it["forecasts"][0]["oos"]] for it in out["instruments"]}


def test_replayed_forecasts_sit_on_a_fixed_grid_so_rescans_deduplicate() -> None:
    n = 1200
    closes = _walks(n + 3, 2, seed=4)
    ts = T0 + np.arange(n + 3, dtype=np.int64) * H
    grid = 24 * H
    seen: list[dict[str, list[int]]] = []
    for shift in range(3):  # three consecutive hourly scans (the window slides by one bar)
        out = _scan(closes[:, shift : shift + n], ts[shift : shift + n], width=n)
        seen.append(_replay_times(out))
    for times in seen:
        for sym, ps in times.items():
            assert ps, sym
            assert all(p % grid == 0 for p in ps), (sym, ps[:3])
            assert all(b - a >= grid for a, b in itertools.pairwise(ps))
    # Every time replayed by a later scan that was inside the earlier window was replayed before.
    for sym in seen[0]:
        a, b = set(seen[0][sym]), set(seen[1][sym])
        inner = {p for p in b if min(a) <= p <= max(a)}
        assert inner <= a, sorted(inner - a)[:3]
