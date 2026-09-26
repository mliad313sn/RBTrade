"""Incremental scans on bar close, per timeframe.

`ScanState` keeps the trailing `window` bars of every instrument for one timeframe. On each bar
close it appends the new bars (one per instrument that printed) and recomputes the features of
the window, returning the latest column. The window (default 600 bars) covers the longest finite
window (20 same-hour days for seasonality) and lets the recursive filters (Wilder smoothing, the
regime filter) forget their seed: the latest column matches a full-history scan to within 1e-6
(tested).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from numpy.typing import NDArray

from .detectors import compute, last_column
from .panel import Panel, ScanConfig


@dataclass
class NewBar:
    t: int
    o: float
    h: float
    lo: float
    c: float
    v: float


@dataclass
class ScanState:
    panel: Panel
    cfg: ScanConfig = field(default_factory=ScanConfig)
    window: int = 600

    def __post_init__(self) -> None:
        self._trim()

    def _trim(self) -> None:
        """Keeps (a private copy of) the last `window` columns."""
        p = self.panel
        s = slice(max(0, p.width - self.window), p.width)
        self.panel = Panel(
            p.symbols,
            p.t[:, s].copy(),
            p.o[:, s].copy(),
            p.h[:, s].copy(),
            p.lo[:, s].copy(),
            p.c[:, s].copy(),
            p.v[:, s].copy(),
            p.tf_ms,
            p.sector,
            p.region,
            p.events,
        )

    def on_bar_close(self, bars: dict[int, NewBar]) -> list[dict[str, float]]:
        """Appends one bar per instrument index in `bars` (instruments without a bar keep their
        series: the panel is in instrument time) and returns the latest features."""
        p = self.panel
        for i, b in bars.items():
            for arr, val in ((p.o, b.o), (p.h, b.h), (p.lo, b.lo), (p.c, b.c), (p.v, b.v)):
                arr[i, :-1] = arr[i, 1:]
                arr[i, -1] = val
            p.t[i, :-1] = p.t[i, 1:]
            p.t[i, -1] = b.t
        return last_column(compute(p, self.cfg))

    def latest(self) -> list[dict[str, float]]:
        return last_column(compute(self.panel, self.cfg))


def roll_in(p: Panel, extra: Panel) -> Panel:
    """Concatenates two panels in time (helper for tests and the benchmark)."""

    def cat(a: NDArray[Any], b: NDArray[Any]) -> NDArray[Any]:
        return np.concatenate([a, b], axis=1)

    return Panel(
        p.symbols,
        cat(p.t, extra.t),
        cat(p.o, extra.o),
        cat(p.h, extra.h),
        cat(p.lo, extra.lo),
        cat(p.c, extra.c),
        cat(p.v, extra.v),
        p.tf_ms,
        p.sector,
        p.region,
        p.events,
    )
