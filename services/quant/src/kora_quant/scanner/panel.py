"""The scan panel: every instrument's own last T bars, right-aligned (column T-1 is each
instrument's latest closed bar), left-padded with NaN when an instrument has fewer bars.

Instrument time, not wall-clock time: a venue that is closed simply has no bars, so an equity's
20-bar window is 20 trading hours while a crypto pair's is 20 calendar hours. Cross-sectional
detectors (relative strength, correlation breaks) compare instruments at the same bar position,
which is documented in docs/adr/0007b-market-intelligence.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from numpy.typing import NDArray

F2 = NDArray[np.float64]
I2 = NDArray[np.int64]
I1 = NDArray[np.int64]


@dataclass(frozen=True)
class ScanConfig:
    """Window lengths (bars). Tests use small windows so values can be worked out by hand."""

    fast: int = 20
    slow: int = 100
    adx: int = 14
    breakout: int = 20
    season: int = 20
    regime_trend_t: float = 1.5
    regime_trend_k: float = 1.5
    regime_vol_mult: float = 2.5
    regime_stay: float = 0.97

    def warmup(self) -> int:
        return max(self.slow + 1, 2 * self.adx + 1, self.breakout + 1)


@dataclass
class Panel:
    symbols: list[str]
    t: I2  # bar start, epoch ms (0 where padded)
    o: F2
    h: F2
    lo: F2
    c: F2
    v: F2
    tf_ms: int
    sector: I1  # group index per instrument (same sector)
    region: I1  # group index per instrument (the "index": same region)
    events: list[I1] = field(default_factory=list)  # sorted event times per instrument (ms)

    @property
    def n(self) -> int:
        return len(self.symbols)

    @property
    def width(self) -> int:
        return int(self.c.shape[1])

    def prefix(self, end: int) -> Panel:
        """Columns 0..end-1: the panel as it was when column end-1 had just closed."""
        return Panel(
            self.symbols,
            self.t[:, :end],
            self.o[:, :end],
            self.h[:, :end],
            self.lo[:, :end],
            self.c[:, :end],
            self.v[:, :end],
            self.tf_ms,
            self.sector,
            self.region,
            self.events,
        )


def group_codes(labels: list[str]) -> I1:
    """Stable integer codes for group labels (first-seen order)."""
    seen: dict[str, int] = {}
    return np.asarray([seen.setdefault(x, len(seen)) for x in labels], dtype=np.int64)


def build_panel(
    symbols: list[str],
    series: list[tuple[list[int], list[float], list[float], list[float], list[float], list[float]]],
    tf_ms: int,
    sectors: list[str],
    regions: list[str],
    events: list[list[int]] | None = None,
    width: int | None = None,
) -> Panel:
    """Right-aligns each instrument's (t, o, h, l, c, v) columns into a panel of `width` bars."""
    n = len(symbols)
    w = width if width is not None else max((len(s[0]) for s in series), default=0)
    shape = (n, w)
    t = np.zeros(shape, dtype=np.int64)
    cols = [np.full(shape, np.nan, dtype=np.float64) for _ in range(5)]
    for i, s in enumerate(series):
        k = min(len(s[0]), w)
        if k == 0:
            continue
        t[i, w - k :] = np.asarray(s[0][-k:], dtype=np.int64)
        for j in range(5):
            cols[j][i, w - k :] = np.asarray(s[j + 1][-k:], dtype=np.float64)
    ev = [np.asarray(sorted(e), dtype=np.int64) for e in (events or [[] for _ in range(n)])]
    return Panel(
        symbols,
        t,
        cols[0],
        cols[1],
        cols[2],
        cols[3],
        cols[4],
        tf_ms,
        group_codes(sectors),
        group_codes(regions),
        ev,
    )
