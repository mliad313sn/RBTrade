"""Reality-check engine: pure rules that flag unrealistic assumptions.

Every rule has a documented rationale in docs/quant/reality-checks.md (same `code`).
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import RealityCheck, TradeSource

IMPLAUSIBLE_WIN_RATE = 0.60
IMPLAUSIBLE_AVG_WIN_R = 2.0
RISK_WARNING = 0.02
RISK_CRITICAL = 0.05
MIN_SAMPLE = 100


@dataclass(frozen=True)
class CheckInput:
    win_rate: float  # 0..1, the rate the user entered (before stress)
    avg_win_r: float  # average win ÷ average loss
    expectancy_after_costs_r: float  # per trade, in R (or in return units for pct imports)
    risk_fraction: float | None  # fraction of equity risked per trade; None when not applicable
    full_kelly: float  # 0 when there is no edge
    imported_trades: int | None = None
    source: TradeSource | None = None


def evaluate(x: CheckInput) -> list[RealityCheck]:
    """Returns the checks that fire, most severe first. An empty list means none fired."""
    out: list[RealityCheck] = []
    if x.win_rate >= IMPLAUSIBLE_WIN_RATE and x.avg_win_r >= IMPLAUSIBLE_AVG_WIN_R:
        out.append(
            RealityCheck(
                code="implausible_edge",
                severity="critical",
                title="Implausible edge",
                message=(
                    f"Winning {x.win_rate:.0%} of trades while wins average {x.avg_win_r:.2g}× the "
                    "loss is far beyond what persists in real markets. Treat the projection as "
                    "fantasy until an out-of-sample record supports it."
                ),
            )
        )
    if x.expectancy_after_costs_r <= 0:
        out.append(
            RealityCheck(
                code="no_edge_after_costs",
                severity="critical",
                title="No edge after costs",
                message=(
                    "After costs the average trade loses money. More trades or larger size only "
                    "make the expected result worse."
                ),
            )
        )
    if x.risk_fraction is not None and x.full_kelly > 0 and x.risk_fraction > x.full_kelly:
        out.append(
            RealityCheck(
                code="above_full_kelly",
                severity="critical",
                title="Sizing above full Kelly",
                message=(
                    f"You risk {x.risk_fraction:.2%} per trade; full Kelly for this edge is "
                    f"{x.full_kelly:.2%}. Above full Kelly, growth falls while drawdowns grow."
                ),
            )
        )
    if x.risk_fraction is not None and x.risk_fraction > RISK_WARNING:
        critical = x.risk_fraction > RISK_CRITICAL
        out.append(
            RealityCheck(
                code="risk_above_2pct",
                severity="critical" if critical else "warning",
                title="Risk above 2% per trade",
                message=(
                    f"Risking {x.risk_fraction:.2%} per trade means a normal losing streak of 10 "
                    f"costs about {1 - (1 - x.risk_fraction) ** 10:.0%} of the account."
                ),
            )
        )
    if x.imported_trades is not None and x.imported_trades < MIN_SAMPLE:
        out.append(
            RealityCheck(
                code="small_sample",
                severity="warning",
                title="Small sample",
                message=(
                    f"Only {x.imported_trades} trades were imported. Below {MIN_SAMPLE}, the win "
                    "rate and average win are too noisy to project from."
                ),
            )
        )
    if x.source == "backtest_in_sample":
        out.append(
            RealityCheck(
                code="in_sample_source",
                severity="warning",
                title="In-sample results",
                message=(
                    "These trades come from the period the strategy was tuned on. Use "
                    "out-of-sample or walk-forward results instead."
                ),
            )
        )
    rank = {"critical": 0, "warning": 1, "info": 2}
    return sorted(out, key=lambda c: rank[c.severity])
