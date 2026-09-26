"""Block-size selection for the circular moving-block bootstrap."""

from __future__ import annotations

import math


def auto_block_size(n: int) -> int:
    """ceil(n^(1/3)), the textbook rate for block length (Hall, Horowitz & Jing 1995), in [1, n].

    Blocks keep short-range dependence between consecutive trades (streaks, regime clusters) that an
    i.i.d. resample would destroy. See docs/quant/monte-carlo.md.
    """
    if n < 1:
        raise ValueError("need at least one trade")
    return max(1, min(n, math.ceil(math.pow(n, 1.0 / 3.0) - 1e-9)))
