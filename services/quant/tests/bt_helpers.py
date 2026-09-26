"""Shared fixtures for the research-engine tests (SIMULATED synthetic series only)."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

HOUR_MS = 3_600_000
T0 = 1_767_571_200_000  # 2026-01-05T00:00:00Z (a Monday)

TOY_COSTS: dict[str, Any] = {
    "tickSize": 0.01,
    "pricePrecision": 2,
    "qtyStep": "1",
    "minQty": "1",
    "multiplier": 1.0,
    "commissionBps": 0.0,
    "commissionPerUnit": 0.5,
    "commissionMin": 1.0,
    "swapLongBps": 0.0,
    "swapShortBps": 0.0,
    "impactTicks": 0.0,
    "volFactor": 0.0,
    "spreadTicks": 2.0,
    "fxToBase": 1.0,
    "currencyDecimals": 2,
}

# o, h, l, c — designed so every trade can be computed by hand (see test_bt_toy.py).
TOY_BARS: list[tuple[float, float, float, float]] = [
    (100.0, 101.0, 99.0, 100.0),
    (100.0, 101.0, 99.0, 100.5),
    (100.5, 101.0, 100.0, 100.8),
    (100.8, 103.0, 100.7, 102.5),
    (102.6, 104.0, 102.4, 103.5),
    (103.5, 107.0, 103.2, 106.0),
    (106.2, 106.5, 105.0, 105.5),
    (105.5, 105.8, 104.0, 104.2),
    (104.2, 104.5, 103.0, 103.5),
    (103.4, 104.0, 103.0, 103.8),
    (103.8, 104.0, 103.5, 103.9),
    (103.9, 107.1, 103.8, 107.0),
    (107.0, 112.0, 101.0, 108.0),
    (108.5, 109.0, 108.0, 108.5),
]

TOY_DEFINITION: dict[str, Any] = {
    "schema": "kora.strategy",
    "schemaVersion": 1,
    "name": "Toy breakout",
    "universe": {"symbols": ["TOY"], "timeframe": "1h"},
    "params": {},
    "entry": {
        "side": "long",
        "conditions": [
            {
                "type": "compare",
                "left": {"kind": "indicator", "name": "close"},
                "op": "gt",
                "right": {"kind": "indicator", "name": "highest", "period": 3},
            }
        ],
    },
    "filters": [],
    "exit": {
        "stop": {"kind": "percent", "pct": 5},
        "target": {"kind": "percent", "pct": 4},
        "timeStopBars": 3,
        "conditions": [],
    },
    "size": {"kind": "fixed", "qty": "1", "maxOpenPositions": 1},
}


def bars_wire(
    rows: list[tuple[float, float, float, float]], t0: int = T0, step: int = HOUR_MS
) -> dict[str, Any]:
    return {
        "t": [t0 + i * step for i in range(len(rows))],
        "o": [r[0] for r in rows],
        "h": [r[1] for r in rows],
        "l": [r[2] for r in rows],
        "c": [r[3] for r in rows],
        "v": [1.0] * len(rows),
    }


def toy_request(**extra: Any) -> dict[str, Any]:
    return {
        "definition": TOY_DEFINITION,
        "data": [{"symbol": "TOY", "bars": bars_wire(TOY_BARS), "costs": TOY_COSTS}],
        "capital": 100_000.0,
        **extra,
    }


def synthetic_series(
    n: int, seed: int = 7, start: float = 100.0, drift: float = 0.0, vol: float = 0.01
) -> list[tuple[float, float, float, float]]:
    """Deterministic cyclical + noisy series on a 0.01 grid (SIMULATED)."""
    rng = np.random.default_rng(seed)
    rows: list[tuple[float, float, float, float]] = []
    price = start
    for i in range(n):
        cyc = 0.004 * math.sin(i / 25.0)
        r = drift + cyc + vol * float(rng.standard_normal())
        o = price
        c = max(1.0, o * math.exp(r))
        h = max(o, c) * (1 + abs(float(rng.standard_normal())) * vol * 0.4)
        lo = min(o, c) * (1 - abs(float(rng.standard_normal())) * vol * 0.4)
        rows.append((round(o, 2), round(h + 0.005, 2), round(lo - 0.005, 2), round(c, 2)))
        price = round(c, 2)
    fixed: list[tuple[float, float, float, float]] = []
    for o, h, lo, c in rows:
        fixed.append((o, max(h, o, c), min(lo, o, c), c))
    return fixed


def ema_cross_definition(fast: int = 10, slow: int = 30, side: str = "long") -> dict[str, Any]:
    return {
        "schema": "kora.strategy",
        "schemaVersion": 1,
        "name": "EMA cross",
        "universe": {"symbols": ["SYN"], "timeframe": "1h"},
        "params": {
            "fast": {"value": fast, "min": 2, "max": 100, "integer": True},
            "slow": {"value": slow, "min": 5, "max": 300, "integer": True},
            "stop_atr": {"value": 2.0, "min": 0.5, "max": 5},
        },
        "entry": {
            "side": side,
            "conditions": [
                {
                    "type": "cross",
                    "left": {"kind": "indicator", "name": "ema", "period": {"param": "fast"}},
                    "direction": "above" if side == "long" else "below",
                    "right": {"kind": "indicator", "name": "ema", "period": {"param": "slow"}},
                }
            ],
        },
        "filters": [],
        "exit": {
            "stop": {"kind": "atr", "multiple": {"param": "stop_atr"}, "period": 14},
            "target": {"kind": "r", "multiple": 2},
            "trailing": {"afterR": 1, "kind": "atr", "multiple": 2, "period": 14},
            "conditions": [
                {
                    "type": "cross",
                    "left": {"kind": "indicator", "name": "ema", "period": {"param": "fast"}},
                    "direction": "below" if side == "long" else "above",
                    "right": {"kind": "indicator", "name": "ema", "period": {"param": "slow"}},
                }
            ],
        },
        "size": {"kind": "risk_pct", "pct": 1, "maxOpenPositions": 1},
    }


SYN_COSTS: dict[str, Any] = {
    **TOY_COSTS,
    "commissionPerUnit": 0.0,
    "commissionMin": 0.0,
    "commissionBps": 1.0,
    "qtyStep": "0.01",
    "minQty": "0.01",
    "volFactor": 0.1,
    "swapLongBps": -100.0,
    "swapShortBps": -50.0,
}


def syn_request(n: int = 1500, **extra: Any) -> dict[str, Any]:
    return {
        "definition": ema_cross_definition(),
        "data": [{"symbol": "SYN", "bars": bars_wire(synthetic_series(n)), "costs": SYN_COSTS}],
        "capital": 100_000.0,
        **extra,
    }
