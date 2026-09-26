"""Performance metrics for a segment of a backtest (in-sample, out-of-sample, walk-forward, live).

- Returns are daily (UTC) equity returns: the last equity of each day, starting from the equity just
  before the segment. Annualisation factor A = observed days per year (≈ 365 for 24/7 data, ≈ 252
  for
  weekday data), so no calendar is assumed.
- Sharpe = mean / stdev (ddof 1) × √A; Sortino = mean / downside deviation × √A with downside
  deviation
  √mean(min(r, 0)²); CAGR = (E_end / E_start)^(365.25 / days) − 1; Calmar = CAGR / |max DD|.
- Max drawdown on the bar-close equity path; its duration is the longest time (days) from a peak to
  the recovery of that peak (or the end of the segment).
- Trades are attributed to the segment of their entry. Win rate, profit factor (gross wins / gross
  losses), expectancy in R and in currency, trade count.
- Exposure = share of bars with an open position. Turnover = traded notional / average equity per
  year (×/yr). Cost drag = commission + spread/slippage + funding / average equity per year (%/yr).
- Per-period (daily) Sharpe, skewness, Pearson kurtosis and observation count feed the DSR.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .engine import DAY_MS, EngineResult, Fill, Trade


def _f(x: float | None, nd: int = 6) -> float | None:
    if x is None or not math.isfinite(x):
        return None
    return round(float(x), nd)


def daily_returns(ts: np.ndarray, equity: np.ndarray, start_equity: float) -> np.ndarray:
    if len(ts) == 0:
        return np.array([], dtype=np.float64)
    days = (ts - 1) // DAY_MS  # a bar closing exactly at midnight belongs to the previous day
    last_idx = np.flatnonzero(np.r_[days[1:] != days[:-1], True])
    closes = np.r_[start_equity, equity[last_idx]]
    with np.errstate(divide="ignore", invalid="ignore"):
        r = closes[1:] / closes[:-1] - 1.0
    out: np.ndarray = r[np.isfinite(r)]
    return out


def max_drawdown(ts: np.ndarray, equity: np.ndarray, start_equity: float) -> tuple[float, float]:
    """(max drawdown as a negative fraction, longest drawdown duration in days)."""
    if len(equity) == 0:
        return 0.0, 0.0
    path = np.r_[start_equity, equity]
    times = np.r_[ts[0] - (ts[1] - ts[0] if len(ts) > 1 else 0), ts]
    peak = np.maximum.accumulate(path)
    dd = path / peak - 1.0
    longest = 0.0
    start: int | None = None
    for i in range(len(path)):
        if path[i] >= peak[i]:
            if start is not None:
                longest = max(longest, (times[i] - times[start]) / DAY_MS)
            start = i
    if start is not None and path[-1] < peak[-1]:
        longest = max(longest, (times[-1] - times[start]) / DAY_MS)
    return float(dd.min()), float(longest)


def segment_metrics(
    res: EngineResult, t0: int | None, t1: int | None, trades: list[Trade] | None = None
) -> dict[str, Any]:
    """Metrics for bar closes in (t0, t1] (None = open-ended) and trades entered in [t0, t1)."""
    ts, eq = res.ts, res.equity
    lo = 0 if t0 is None else int(np.searchsorted(ts, t0, side="right"))
    hi = len(ts) if t1 is None else int(np.searchsorted(ts, t1, side="right"))
    seg_ts, seg_eq, seg_mkt = ts[lo:hi], eq[lo:hi], res.in_market[lo:hi]
    start_eq = float(eq[lo - 1]) if lo > 0 else res.capital
    tr = [
        t
        for t in (trades if trades is not None else res.trades)
        if (t0 is None or t.entry_ts >= t0) and (t1 is None or t.entry_ts < t1)
    ]
    return compute_metrics(seg_ts, seg_eq, seg_mkt, start_eq, tr, res.fills, res.swaps, t0, t1)


def compute_metrics(
    ts: np.ndarray,
    eq: np.ndarray,
    in_market: np.ndarray,
    start_eq: float,
    trades: list[Trade],
    fills: list[Fill],
    swaps: list[tuple[int, float]],
    t0: int | None,
    t1: int | None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"bars": len(ts), "trades": len(trades)}
    if len(ts) == 0:
        return {**out, **dict.fromkeys(METRIC_KEYS)}
    r = daily_returns(ts, eq, start_eq)
    first_day = (ts[0] - 1) // DAY_MS
    last_day = (ts[-1] - 1) // DAY_MS
    span_days = max(1.0, float(last_day - first_day + 1))
    years = span_days / 365.25
    ann = min(366.0, max(1.0, len(r) / years)) if len(r) else 365.0
    mean = float(np.mean(r)) if len(r) else 0.0
    sd = float(np.std(r, ddof=1)) if len(r) > 1 else 0.0
    sharpe_pp = mean / sd if sd > 0 else None
    downside = float(np.sqrt(np.mean(np.minimum(r, 0.0) ** 2))) if len(r) else 0.0
    end_eq = float(eq[-1])
    cagr = (
        (end_eq / start_eq) ** (365.25 / span_days) - 1.0 if start_eq > 0 and end_eq > 0 else -1.0
    )
    mdd, mdd_days = max_drawdown(ts, eq, start_eq)
    wins = [t.net_pnl for t in trades if t.net_pnl > 0]
    losses = [t.net_pnl for t in trades if t.net_pnl <= 0]
    avg_eq = float(np.mean(np.r_[start_eq, eq]))
    notional = costs = 0.0
    for f in fills:
        if (t0 is None or f.ts >= t0) and (t1 is None or f.ts < t1):
            notional += f.notional_base
            costs += f.commission_base + f.spread_base
    for when, amt in swaps:
        if (t0 is None or when > t0) and (t1 is None or when <= t1):
            costs += -amt if amt < 0 else 0.0
    skew = kurt = None
    if len(r) > 2 and sd > 0:
        z = (r - mean) / float(np.std(r))
        skew = float(np.mean(z**3))
        kurt = float(np.mean(z**4))
    out.update(
        {
            "cagr": _f(cagr),
            "sharpe": _f(sharpe_pp * math.sqrt(ann) if sharpe_pp is not None else None, 4),
            "sortino": _f(mean / downside * math.sqrt(ann) if downside > 0 else None, 4),
            "calmar": _f(cagr / abs(mdd) if mdd < 0 else None, 4),
            "maxDrawdown": _f(mdd),
            "maxDrawdownDays": _f(mdd_days, 2),
            "winRate": _f(len(wins) / len(trades) if trades else None, 4),
            "profitFactor": _f(
                sum(wins) / abs(sum(losses)) if losses and sum(losses) < 0 else None, 4
            ),
            "expectancyR": _f(
                float(np.mean([t.r_multiple for t in trades])) if trades else None, 4
            ),
            "expectancyCcy": _f(float(np.mean([t.net_pnl for t in trades])) if trades else None, 2),
            "exposurePct": _f(float(np.mean(in_market)) * 100 if len(in_market) else None, 2),
            "turnover": _f(notional / avg_eq / years if avg_eq > 0 else None, 3),
            "costDragPct": _f(costs / avg_eq / years * 100 if avg_eq > 0 else None, 3),
            "netPnl": _f(end_eq - start_eq, 2),
            "startEquity": _f(start_eq, 2),
            "endEquity": _f(end_eq, 2),
            "days": _f(span_days, 2),
            "annualisation": _f(ann, 2),
            "periodSharpe": _f(sharpe_pp, 6),
            "observations": len(r),
            "skew": _f(skew, 4),
            "kurtosis": _f(kurt, 4),
        }
    )
    return out


METRIC_KEYS = [
    "cagr",
    "sharpe",
    "sortino",
    "calmar",
    "maxDrawdown",
    "maxDrawdownDays",
    "winRate",
    "profitFactor",
    "expectancyR",
    "expectancyCcy",
    "exposurePct",
    "turnover",
    "costDragPct",
    "netPnl",
    "startEquity",
    "endEquity",
    "days",
    "annualisation",
    "periodSharpe",
    "observations",
    "skew",
    "kurtosis",
]
