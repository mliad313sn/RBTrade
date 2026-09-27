"""Look-ahead guard for the scanner (same idea as goal 06 `bt.evaluate.verify_point_in_time`).

Every feature of every bar must be identical whether it is computed on the full panel or on the
panel *as it was at a wall-clock time T*: every instrument keeps only its bars that started at or
before T (IRTC R3-05). Any difference means a detector used information from after T, and the scan
is refused with `LookAheadError`.

Why wall-clock time and not a column prefix: the panel is right-aligned per instrument, so a column
can mix times when an instrument is stale, halted or on another calendar; a column prefix cannot
see a cross-sectional leak between such instruments (IRTC R3-04).

Checkpoints (at least `MIN_CHECKPOINTS`) are taken after the warm-up and before the last bar: half
spread evenly, half drawn at random (seeded from the data, so a run is reproducible). At each one
every bar up to T is compared, not only the bar at T, so a leak that looks a few bars ahead shows up
whenever such a bar falls in that tail. `GuardResult.compared` counts finite values compared; a scan
that compared nothing (history shorter than the warm-up) is reported as not verified.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from ..bt.evaluate import LookAheadError
from . import detectors
from .detectors import Features
from .panel import Panel, ScanConfig

ScanFn = Callable[[Panel, ScanConfig], Features]
MIN_CHECKPOINTS = 8


@dataclass(frozen=True)
class GuardResult:
    checkpoints: int
    compared: int

    @property
    def verified(self) -> bool:
        return self.compared > 0


def as_of(p: Panel, cutoff: int) -> Panel:
    """The panel as it was at wall-clock time `cutoff`: bars starting after it become padding."""
    keep = (p.t > 0) & (p.t <= cutoff)

    def mask(x: np.ndarray) -> np.ndarray:
        return np.where(keep, x, np.nan)

    return Panel(
        p.symbols,
        np.where(keep, p.t, 0),
        mask(p.o),
        mask(p.h),
        mask(p.lo),
        mask(p.c),
        mask(p.v),
        p.tf_ms,
        p.sector,
        p.region,
        p.events,
    )


def checkpoint_times(p: Panel, cfg: ScanConfig, checkpoints: int) -> list[int]:
    times = np.unique(p.t[p.t > 0])
    if len(times) < 2:
        return []
    start = min(cfg.warmup(), len(times) - 2)
    pool = times[start:-1]  # after the warm-up; never the last time (as-of == full there)
    k = min(len(pool), max(checkpoints, MIN_CHECKPOINTS))
    spread = {int(pool[int(i)]) for i in np.linspace(0, len(pool) - 1, num=(k + 1) // 2)}
    rest = np.array([x for x in pool if int(x) not in spread], dtype=np.int64)
    seed = int(times[-1] // max(p.tf_ms, 1)) % (2**32) ^ len(times)
    n_random = min(len(rest), k - len(spread))
    drawn = np.random.default_rng(seed).choice(rest, size=n_random, replace=False)
    return sorted(spread | {int(x) for x in drawn})


def verify_scan_point_in_time(
    p: Panel,
    cfg: ScanConfig,
    full: Features,
    checkpoints: int = MIN_CHECKPOINTS,
    fn: ScanFn | None = None,
) -> GuardResult:
    """Recomputes the scan as of each checkpoint time and compares every bar up to it."""
    scan = fn or detectors.compute
    compared = 0
    points = checkpoint_times(p, cfg, checkpoints)
    for cutoff in points:
        part = scan(as_of(p, cutoff), cfg)
        rows = (p.t > 0) & (p.t <= cutoff)
        for name, arr in full.items():
            a, b = arr[rows], part[name][rows]
            both_nan = np.isnan(a) & np.isnan(b)
            close = np.isclose(a, b, rtol=1e-9, atol=1e-12)
            compared += int(np.count_nonzero(np.isfinite(a) & np.isfinite(b)))
            bad = np.nonzero(~(both_nan | close))[0]
            if len(bad):
                ii, jj = np.nonzero(rows)
                i, j = int(ii[bad[0]]), int(jj[bad[0]])
                va, vb = float(arr[i, j]), float(part[name][i, j])
                raise LookAheadError(
                    f"Look-ahead detected: scanner feature {name} of {p.symbols[i]} at bar {j} is "
                    f"{'NaN' if math.isnan(va) else va} with the full panel but "
                    f"{'NaN' if math.isnan(vb) else vb} with only the data known at that time. "
                    "The scan used future data and was stopped."
                )
    return GuardResult(checkpoints=len(points), compared=compared)
