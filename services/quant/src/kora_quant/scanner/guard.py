"""Look-ahead guard for the scanner (same idea as goal 06 `bt.evaluate.verify_point_in_time`).

Every feature at column t must be identical whether it is computed on the full panel or on the
panel as it was when column t had just closed (columns 0..t). Any difference means a detector
used future bars, and the scan is refused with `LookAheadError`.
"""

from __future__ import annotations

import math
from collections.abc import Callable

import numpy as np

from ..bt.evaluate import LookAheadError
from . import detectors
from .detectors import Features
from .panel import Panel, ScanConfig

ScanFn = Callable[[Panel, ScanConfig], Features]


def verify_scan_point_in_time(
    p: Panel,
    cfg: ScanConfig,
    full: Features,
    checkpoints: int = 6,
    fn: ScanFn | None = None,
) -> int:
    """Recomputes the scan on prefixes at `checkpoints` columns (always including the last) and
    compares column t of each feature. Returns the number of columns verified."""
    scan = fn or detectors.compute
    w = p.width
    if w == 0:
        return 0
    points = sorted({int(x) for x in np.linspace(0, w - 1, num=min(checkpoints, w))} | {w - 1})
    for t in points:
        part = scan(p.prefix(t + 1), cfg)
        for name, arr in full.items():
            a, b = arr[:, t], part[name][:, t]
            both_nan = np.isnan(a) & np.isnan(b)
            close = np.isclose(a, b, rtol=1e-9, atol=1e-12)
            bad = np.nonzero(~(both_nan | close))[0]
            if len(bad):
                i = int(bad[0])
                va, vb = float(a[i]), float(b[i])
                raise LookAheadError(
                    f"Look-ahead detected: scanner feature {name} of {p.symbols[i]} at bar {t} is "
                    f"{'NaN' if math.isnan(va) else va} with the full panel but "
                    f"{'NaN' if math.isnan(vb) else vb} with only the bars up to it. The scan used "
                    "future data and was stopped."
                )
    return len(points)
