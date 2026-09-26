"""Deterministic SIMULATED universes for the scanner benchmark and tests.

Nothing here is market data: prices follow a geometric random walk with Markov-switching
volatility (seeded numpy PCG64). Symbols are synthetic (`SIM00042`) and never enter the registry.
"""

from __future__ import annotations

import numpy as np

from .panel import Panel, group_codes

REGIONS = ("americas", "europe", "africa", "asia", "oceania")
ASSET_CLASSES = (
    "equity",
    "etf",
    "bond",
    "future",
    "option",
    "fx",
    "metal",
    "energy",
    "agri",
    "crypto",
    "index",
    "cfd",
    "fund",
)
SECTORS = (
    "technology",
    "financials",
    "energy",
    "materials",
    "industrials",
    "health_care",
    "consumer",
    "utilities",
    "real_estate",
    "communication",
    "macro",
)
HOUR_MS = 3_600_000
T0 = 1_767_571_200_000  # 2026-01-05T00:00:00Z


def universe(
    n: int,
    bars: int,
    seed: int = 7,
    tf_ms: int = HOUR_MS,
    ar: float = 0.0,
) -> tuple[Panel, list[str], list[str]]:
    """n synthetic instruments × `bars` bars. `ar` plants first-order return autocorrelation
    (0 = pure random walk, the honest default: no forecastable signal). Returns the panel plus
    the asset-class and region labels."""
    rng = np.random.Generator(np.random.PCG64(seed))
    regions = [REGIONS[i % len(REGIONS)] for i in range(n)]
    classes = [ASSET_CLASSES[(i // len(REGIONS)) % len(ASSET_CLASSES)] for i in range(n)]
    sectors = [SECTORS[(i * 7) % len(SECTORS)] for i in range(n)]
    base_vol = rng.uniform(0.002, 0.012, size=n)
    state = np.zeros(n, dtype=bool)
    r = np.zeros((n, bars))
    prev = np.zeros(n)
    for t in range(bars):
        flip = rng.random(n) < np.where(state, 0.05, 0.01)
        state = state ^ flip
        sig = base_vol * np.where(state, 2.5, 1.0)
        eps = rng.standard_normal(n) * sig
        prev = ar * prev + eps
        r[:, t] = prev
    start = rng.uniform(5.0, 500.0, size=n)
    c = start[:, None] * np.exp(np.cumsum(r, axis=1))
    o = np.empty_like(c)
    o[:, 0] = start
    o[:, 1:] = c[:, :-1]
    wig = np.abs(rng.standard_normal((n, bars, 2))) * base_vol[:, None, None] * 0.5
    h = np.maximum(o, c) * np.exp(wig[:, :, 0])
    lo = np.minimum(o, c) * np.exp(-wig[:, :, 1])
    v = np.round(rng.lognormal(8.0, 0.6, size=(n, bars)))
    t_ms = T0 + np.arange(bars, dtype=np.int64)[None, :] * tf_ms
    t_all = np.repeat(t_ms, n, axis=0)
    symbols = [f"SIM{i:05d}" for i in range(n)]
    events = [
        [int(T0 + ((i % 5) * 7 + d * 24) * HOUR_MS) for d in range(0, bars // 24 + 2)]
        if classes[i] in ("fx", "index", "bond")
        else []
        for i in range(n)
    ]
    p = Panel(
        symbols,
        t_all,
        o,
        h,
        lo,
        c,
        v,
        tf_ms,
        group_codes(sectors),
        group_codes(regions),
        [np.asarray(e, dtype=np.int64) for e in events],
    )
    return p, classes, regions
