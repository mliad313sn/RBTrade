"""Wire models for the gain simulator (camelCase JSON, validated twice: api zod + here).

Simulation inputs and outputs are statistical parameters and estimates (float64). They are never
booked as money; paper-account P&L is computed with Decimal in `paper.py` (ADR 0005).
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

DEFAULT_PATHS = 10_000
MAX_PATHS = 50_000
MAX_TRADES_PER_PATH = 5_000
MAX_WORK = 50_000_000  # paths × trades per request
MAX_IMPORTED_TRADES = 20_000
SAMPLE_PATHS = 3
HISTOGRAM_BINS = 20


class Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


SizingModel = Literal["fixed_fractional", "fixed_amount", "kelly_fraction"]
Severity = Literal["info", "warning", "critical"]
TradeSource = Literal["backtest_in_sample", "backtest_out_of_sample", "paper", "manual"]


class OneOffWithdrawal(Wire):
    period: Annotated[int, Field(ge=1, le=600)]
    amount: Annotated[float, Field(ge=0, le=1e12)]


class Withdrawals(Wire):
    per_period: Annotated[float, Field(ge=0, le=1e12)] = 0.0
    one_off: Annotated[list[OneOffWithdrawal], Field(max_length=120, default_factory=list)]


class RunShape(Wire):
    starting_capital: Annotated[float, Field(gt=0, le=1e12)] = 10_000.0
    trades_per_period: Annotated[int, Field(ge=1, le=500)] = 20
    horizon_periods: Annotated[int, Field(ge=1, le=600)] = 24
    ruin_floor_pct: Annotated[float, Field(ge=0, lt=100)] = 50.0
    withdrawals: Withdrawals = Withdrawals()
    seed: Annotated[int, Field(ge=0, le=2**63 - 1)] = 1
    paths: Annotated[int, Field(ge=100, le=MAX_PATHS)] = DEFAULT_PATHS

    @property
    def trades_total(self) -> int:
        return self.trades_per_period * self.horizon_periods

    @model_validator(mode="after")
    def _budget(self) -> RunShape:
        if self.trades_total > MAX_TRADES_PER_PATH:
            raise ValueError(
                f"trades per period × horizon = {self.trades_total} trades per path; the limit is "
                f"{MAX_TRADES_PER_PATH}. Shorten the horizon or trade less often."
            )
        if self.trades_total * self.paths > MAX_WORK:
            raise ValueError(
                f"paths × trades = {self.trades_total * self.paths:,} exceeds {MAX_WORK:,}. "
                "Reduce the number of paths or the horizon."
            )
        return self


class ProjectRequest(RunShape):
    sizing_model: SizingModel = "fixed_fractional"
    risk_pct: Annotated[float, Field(gt=0, le=25)] = 1.0
    fixed_amount: Annotated[float, Field(gt=0, le=1e12)] = 100.0
    kelly_fraction: Annotated[float, Field(gt=0, le=2)] = 0.5
    win_rate_pct: Annotated[float, Field(ge=1, le=99)] = 45.0
    avg_win_r: Annotated[float, Field(ge=0.05, le=20)] = 1.8
    cost_per_trade_r: Annotated[float, Field(ge=0, le=5)] = 0.08
    fat_tail_prob_pct: Annotated[float, Field(ge=0, le=50)] = 0.0
    fat_tail_multiple: Annotated[float, Field(ge=1, le=20)] = 3.0
    stress_edge_cut_pct: Annotated[float, Field(ge=0, le=100)] = 0.0


class FromTradesRequest(RunShape):
    trades: Annotated[list[float], Field(min_length=2, max_length=MAX_IMPORTED_TRADES)]
    trade_unit: Literal["r_multiple", "pct_return"] = "r_multiple"
    risk_pct: Annotated[float, Field(gt=0, le=25)] = 1.0
    extra_cost_per_trade_r: Annotated[float, Field(ge=0, le=5)] = 0.0
    block_size: Annotated[int | None, Field(ge=1, le=1000)] = None
    source: TradeSource = "manual"

    @model_validator(mode="after")
    def _trades(self) -> FromTradesRequest:
        for i, t in enumerate(self.trades):
            if t != t or abs(t) == float("inf"):
                raise ValueError(f"trade {i} is not a finite number")
            if self.trade_unit == "pct_return" and not -100 < t <= 1000:
                raise ValueError(
                    f"trade {i}: a per-trade return of {t}% is outside (-100%, 1000%]."
                )
            if self.trade_unit == "r_multiple" and abs(t) > 100:
                raise ValueError(f"trade {i}: {t} R is outside ±100 R.")
        if self.block_size is not None and self.block_size > len(self.trades):
            raise ValueError("block size cannot exceed the number of imported trades")
        return self


class Histogram(Wire):
    edges: list[float]
    counts: list[int]


class Bands(Wire):
    p5: list[float]
    p25: list[float]
    p50: list[float]
    p75: list[float]
    p95: list[float]
    mean: list[float]


class FinalEquity(Wire):
    p5: float
    p25: float
    p50: float
    p75: float
    p95: float
    mean: float
    histogram: Histogram


class Drawdown(Wire):
    median: float
    p95: float
    histogram: Histogram


class Distribution(Wire):
    median: float
    p95: float


class Kelly(Wire):
    full: float
    user_fraction: float
    ratio: float | None


class RealityCheck(Wire):
    code: str
    severity: Severity
    title: str
    message: str


class Effective(Wire):
    """The parameters the engine actually used (after stress), so the UI can show them."""

    win_rate_pct: float
    avg_win_r: float
    avg_loss_r: float
    cost_per_trade_r: float
    risk_fraction: float | None
    block_size: int | None = None


class SimResult(Wire):
    kind: Literal["project", "from_trades"]
    simulated: Literal[True] = True
    input_hash: str
    cache: Literal["hit", "miss"]
    seed: int
    paths: int
    trades_per_path: int
    periods: int
    starting_capital: float
    ruin_floor: float
    bands: Bands
    sample_paths: list[list[float]]
    final_equity: FinalEquity
    prob_end_below_start: float
    risk_of_ruin: float
    risk_of_ruin_approx: float | None
    max_drawdown: Drawdown
    time_under_water: Distribution
    longest_losing_streak: Distribution
    expectancy_r: float
    expectancy_gross_r: float
    expectancy_unit: Literal["r", "pct"]
    kelly: Kelly
    effective: Effective
    reality_checks: list[RealityCheck]
    elapsed_ms: float
    disclaimer: str


class RealityCheckRequest(Wire):
    win_rate_pct: Annotated[float, Field(ge=0, le=100)]
    avg_win_r: Annotated[float, Field(ge=0, le=100)]
    cost_per_trade_r: Annotated[float, Field(ge=0, le=100)] = 0.0
    risk_pct: Annotated[float | None, Field(ge=0, le=100)] = None
    fat_tail_prob_pct: Annotated[float, Field(ge=0, le=100)] = 0.0
    fat_tail_multiple: Annotated[float, Field(ge=1, le=100)] = 1.0
    imported_trades: Annotated[int | None, Field(ge=0)] = None
    source: TradeSource | None = None


class RealityCheckResponse(Wire):
    checks: list[RealityCheck]
