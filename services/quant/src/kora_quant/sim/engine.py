"""Monte Carlo engine: numpy PCG64 draws + a numba path-accounting kernel.

Determinism: one `numpy.random.Generator(PCG64(seed))` per run, consumed in fixed-size path
chunks in row-major order, so a seed always produces the same stream (and so the same output).
The kernel is single-threaded on purpose: parallel loops would make the result depend on thread
scheduling.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from numba import njit

from .models import (
    HISTOGRAM_BINS,
    SAMPLE_PATHS,
    Bands,
    Distribution,
    Drawdown,
    FinalEquity,
    Histogram,
)

CHUNK_PATHS = 2_048
MODE_FRACTION = 0
MODE_AMOUNT = 1
DRAWDOWN_EDGES = [round(0.05 * i, 2) for i in range(15)] + [1.0]  # 0%, 5%, ..., 70%, 70%+

F64 = npt.NDArray[np.float64]
I64 = npt.NDArray[np.int64]
Bool = npt.NDArray[np.bool_]


@njit(cache=True, nogil=True)
def outcomes_from_uniforms(
    u: F64, win_rate: float, avg_win: float, cost: float, tail_prob: float, tail_mult: float
) -> F64:
    """One uniform per trade: u < p wins; otherwise (u-p)/(1-p) is a fresh uniform for the tail."""
    rows, cols = u.shape
    out = np.empty((rows, cols))
    lose = 1.0 - win_rate
    for i in range(rows):
        for t in range(cols):
            x = u[i, t]
            if x < win_rate:
                out[i, t] = avg_win - cost
            elif lose > 0.0 and (x - win_rate) / lose < tail_prob:
                out[i, t] = -tail_mult - cost
            else:
                out[i, t] = -1.0 - cost
    return out


@njit(cache=True, nogil=True)
def account_paths(
    r: F64,
    mode: int,
    size: float,
    start: float,
    floor: float,
    trades_per_period: int,
    withdrawals: F64,
    out_equity: F64,
    out_maxdd: F64,
    out_underwater: I64,
    out_streak: I64,
    out_ruined: Bool,
    row0: int,
) -> None:
    """Applies per-trade outcomes to each path.

    mode 0: P&L = outcome × size × current equity (size = fraction risked per 1 R, 1.0 for returns)
    mode 1: P&L = outcome × size (size = fixed currency amount per 1 R)
    A path stops trading once equity <= floor (ruin). Withdrawals come out at each period end and
    lower the peak by the same amount, so they are not counted as drawdown.
    """
    rows, n = r.shape
    for i in range(rows):
        k_out = row0 + i
        eq = start
        peak = start
        maxdd = 0.0
        streak = 0
        best = 0
        under = 0
        ruined = False
        out_equity[k_out, 0] = start
        for t in range(n):
            if not ruined:
                x = r[i, t]
                if mode == MODE_FRACTION:
                    eq += x * size * eq
                else:
                    eq += x * size
                if x < 0.0:
                    streak += 1
                    best = max(best, streak)
                else:
                    streak = 0
                if eq > peak:
                    peak = eq
                if peak > 0.0:
                    dd = (peak - eq) / peak
                    maxdd = max(maxdd, dd)
                if eq <= floor:
                    ruined = True
            if (t + 1) % trades_per_period == 0:
                k = (t + 1) // trades_per_period
                w = withdrawals[k - 1]
                if not ruined and w > 0.0:
                    eq -= w
                    peak = max(peak - w, 0.0)
                    if eq <= floor:
                        ruined = True
                eq = max(eq, 0.0)
                out_equity[k_out, k] = eq
                if eq < peak:
                    under += 1
        out_maxdd[k_out] = min(maxdd, 1.0)
        out_underwater[k_out] = under
        out_streak[k_out] = best
        out_ruined[k_out] = ruined


@dataclass(frozen=True)
class PathSpec:
    paths: int
    trades: int
    trades_per_period: int
    start: float
    floor: float
    mode: int
    size: float
    withdrawals: F64


@dataclass(frozen=True)
class RawRun:
    equity: F64  # (paths, periods + 1)
    maxdd: F64
    underwater: I64
    streak: I64
    ruined: Bool
    elapsed_ms: float


ChunkFn = Callable[[np.random.Generator, int], F64]


def run_paths(spec: PathSpec, seed: int, chunk_outcomes: ChunkFn) -> RawRun:
    """Draws outcomes per chunk (`chunk_outcomes(rng, rows)` → (rows, trades)), then accounts."""
    t0 = time.perf_counter()
    periods = spec.trades // spec.trades_per_period
    equity = np.empty((spec.paths, periods + 1))
    maxdd = np.empty(spec.paths)
    under = np.empty(spec.paths, dtype=np.int64)
    streak = np.empty(spec.paths, dtype=np.int64)
    ruined = np.empty(spec.paths, dtype=np.bool_)
    rng = np.random.Generator(np.random.PCG64(seed))
    for row0 in range(0, spec.paths, CHUNK_PATHS):
        rows = min(CHUNK_PATHS, spec.paths - row0)
        r = chunk_outcomes(rng, rows)
        account_paths(
            r,
            spec.mode,
            spec.size,
            spec.start,
            spec.floor,
            spec.trades_per_period,
            spec.withdrawals,
            equity,
            maxdd,
            under,
            streak,
            ruined,
            row0,
        )
    return RawRun(
        equity=equity,
        maxdd=maxdd,
        underwater=under,
        streak=streak,
        ruined=ruined,
        elapsed_ms=(time.perf_counter() - t0) * 1000.0,
    )


def parametric_chunks(
    trades: int, win_rate: float, avg_win: float, cost: float, tail_prob: float, tail_mult: float
) -> ChunkFn:
    def chunk(rng: np.random.Generator, rows: int) -> F64:
        u = rng.random((rows, trades))
        return outcomes_from_uniforms(u, win_rate, avg_win, cost, tail_prob, tail_mult)

    return chunk


def bootstrap_chunks(outcomes: F64, trades: int, block: int) -> ChunkFn:
    """Circular moving-block bootstrap: each path strings together random `block`-trade blocks."""
    n = len(outcomes)
    blocks = math.ceil(trades / block)
    offsets = np.arange(trades) % block
    which = np.arange(trades) // block

    def chunk(rng: np.random.Generator, rows: int) -> F64:
        starts = rng.integers(0, n, size=(rows, blocks))
        idx = (starts[:, which] + offsets) % n
        return np.asarray(outcomes[idx], dtype=np.float64)

    return chunk


def withdrawal_schedule(periods: int, per_period: float, one_off: list[tuple[int, float]]) -> F64:
    w = np.full(periods, per_period, dtype=np.float64)
    for period, amount in one_off:
        if 1 <= period <= periods:
            w[period - 1] += amount
    return w


def warm_up() -> None:
    """Compiles (or loads from cache) the numba kernels so the first request is fast."""
    spec = PathSpec(8, 4, 2, 100.0, 50.0, MODE_FRACTION, 0.01, np.zeros(2))
    run_paths(spec, 0, parametric_chunks(4, 0.5, 1.0, 0.0, 0.1, 3.0))


# ---- summaries --------------------------------------------------------------------------------


def _q(a: npt.NDArray[np.floating] | npt.NDArray[np.integer], p: float) -> float:
    return float(np.percentile(a, p))


def histogram(values: F64, edges: list[float] | None = None) -> Histogram:
    if edges is None:
        lo, hi = float(np.percentile(values, 0.5)), float(np.percentile(values, 99.5))
        if hi <= lo:
            hi = lo + max(abs(lo) * 1e-6, 1e-9)
        edge_arr = np.linspace(lo, hi, HISTOGRAM_BINS + 1)
        clipped = np.clip(values, lo, hi)
    else:
        edge_arr = np.asarray(edges, dtype=np.float64)
        clipped = np.clip(values, edge_arr[0], edge_arr[-1])
    counts, _ = np.histogram(clipped, bins=edge_arr)
    return Histogram(edges=[float(e) for e in edge_arr], counts=[int(c) for c in counts])


@dataclass(frozen=True)
class Summary:
    bands: Bands
    sample_paths: list[list[float]]
    final_equity: FinalEquity
    prob_end_below_start: float
    risk_of_ruin: float
    max_drawdown: Drawdown
    time_under_water: Distribution
    longest_losing_streak: Distribution


def _round_list(a: F64) -> list[float]:
    return [round(float(x), 6) for x in a]


def summarise(raw: RawRun, start: float) -> Summary:
    eq = raw.equity
    pct = np.percentile(eq, [5, 25, 50, 75, 95], axis=0)
    final = eq[:, -1]
    order = np.argsort(final, kind="stable")
    n = len(final)
    picks = [order[min(n - 1, int(n * q))] for q in (0.25, 0.5, 0.75)][:SAMPLE_PATHS]
    return Summary(
        bands=Bands(
            p5=_round_list(pct[0]),
            p25=_round_list(pct[1]),
            p50=_round_list(pct[2]),
            p75=_round_list(pct[3]),
            p95=_round_list(pct[4]),
            mean=_round_list(eq.mean(axis=0)),
        ),
        sample_paths=[_round_list(eq[i]) for i in picks],
        final_equity=FinalEquity(
            p5=_q(final, 5),
            p25=_q(final, 25),
            p50=_q(final, 50),
            p75=_q(final, 75),
            p95=_q(final, 95),
            mean=float(final.mean()),
            histogram=histogram(final),
        ),
        prob_end_below_start=float(np.mean(final < start)),
        risk_of_ruin=float(np.mean(raw.ruined)),
        max_drawdown=Drawdown(
            median=_q(raw.maxdd, 50),
            p95=_q(raw.maxdd, 95),
            histogram=histogram(raw.maxdd, DRAWDOWN_EDGES),
        ),
        time_under_water=Distribution(median=_q(raw.underwater, 50), p95=_q(raw.underwater, 95)),
        longest_losing_streak=Distribution(median=_q(raw.streak, 50), p95=_q(raw.streak, 95)),
    )
