"""Wire models for the research endpoints (camelCase JSON; the api validates with zod first)."""

from __future__ import annotations

import os
from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from ..sim.models import Wire
from .costs import CostModel

MAX_BARS = 60_000
HARD_MAX_COMBOS = 1_000


def max_combos() -> int:
    """Optimisation hard cap: KORA_BT_MAX_COMBOS (default 200), never above 1,000."""
    try:
        n = int(os.environ.get("KORA_BT_MAX_COMBOS", "200"))
    except ValueError:
        n = 200
    return max(1, min(n, HARD_MAX_COMBOS))


class BarsWire(Wire):
    t: Annotated[list[int], Field(max_length=MAX_BARS)]
    o: Annotated[list[float], Field(max_length=MAX_BARS)]
    h: Annotated[list[float], Field(max_length=MAX_BARS)]
    l: Annotated[list[float], Field(max_length=MAX_BARS)]  # noqa: E741 - OHLC convention
    c: Annotated[list[float], Field(max_length=MAX_BARS)]
    v: Annotated[list[float], Field(max_length=MAX_BARS)]

    @model_validator(mode="after")
    def _shape(self) -> BarsWire:
        n = len(self.t)
        if any(len(x) != n for x in (self.o, self.h, self.l, self.c, self.v)):
            raise ValueError("bar columns must have the same length")
        if any(self.t[i] >= self.t[i + 1] for i in range(n - 1)):
            raise ValueError("bar times must be strictly increasing")
        for i in range(n):
            if not (
                self.l[i] <= min(self.o[i], self.c[i]) <= max(self.o[i], self.c[i]) <= self.h[i]
            ):
                raise ValueError(f"bar {i} is not a valid OHLC bar")
            if self.l[i] <= 0:
                raise ValueError(f"bar {i} has a non-positive price")
        return self


class SymbolData(Wire):
    symbol: Annotated[str, Field(min_length=1, max_length=32)]
    bars: BarsWire
    session_open: list[bool] | None = None
    events: Annotated[list[int] | None, Field(max_length=10_000)] = None
    costs: CostModel

    @model_validator(mode="after")
    def _session(self) -> SymbolData:
        if self.session_open is not None and len(self.session_open) != len(self.bars.t):
            raise ValueError("sessionOpen must have one flag per bar")
        return self


class TrialContext(Wire):
    """Trials already recorded for the strategy (the api counts them, not the client)."""

    count: Annotated[int, Field(ge=0, le=1_000_000)] = 0
    period_sharpes: Annotated[list[float], Field(max_length=20_000, default_factory=list)]


class Split(Wire):
    oos_start: int | None = None
    oos_fraction: Annotated[float, Field(gt=0, lt=1)] = 0.3


class ResearchBase(Wire):
    definition: dict[str, Any]
    param_overrides: dict[str, float] = Field(default_factory=dict)
    data: Annotated[list[SymbolData], Field(min_length=1, max_length=10)]
    capital: Annotated[float, Field(gt=0, le=1e12)] = 100_000.0
    split: Split = Split()
    trials: TrialContext = TrialContext()
    roll_hour_utc: Annotated[int, Field(ge=0, le=23)] = 21
    max_points: Annotated[int, Field(ge=50, le=5_000)] = 1_000


class BacktestRunRequest(ResearchBase):
    guard: bool = True


class WalkForwardRequest(ResearchBase):
    mode: Literal["anchored", "rolling"] = "anchored"
    folds: Annotated[int, Field(ge=2, le=12)] = 4
    train_fraction: Annotated[float, Field(gt=0.2, lt=0.9)] = 0.6
    grid: dict[str, Annotated[list[float], Field(min_length=1, max_length=12)]] | None = None


class OptimiseRequest(ResearchBase):
    method: Literal["grid", "random"] = "grid"
    grid: dict[str, Annotated[list[float], Field(min_length=1, max_length=50)]]
    samples: Annotated[int, Field(ge=1, le=HARD_MAX_COMBOS)] = 50
    seed: Annotated[int, Field(ge=0, le=2**31 - 1)] = 1
    max_combos: Annotated[int | None, Field(ge=1, le=HARD_MAX_COMBOS)] = None


class Axis(Wire):
    param: str
    values: Annotated[list[float], Field(min_length=2, max_length=12)]


class SensitivityRequest(ResearchBase):
    x: Axis
    y: Axis


class PositionWire(Wire):
    side: Literal["long", "short"]
    qty: Annotated[str, Field(pattern=r"^\d+(\.\d+)?$")]
    entry_ref: float
    stop: float
    initial_stop: float
    target: float | None = None
    bars_held: Annotated[int, Field(ge=0)]
    high_water: float


class SignalRequest(Wire):
    definition: dict[str, Any]
    param_overrides: dict[str, float] = Field(default_factory=dict)
    data: SymbolData
    position: PositionWire | None = None
    equity: Annotated[float, Field(ge=0)]
    open_positions: Annotated[int, Field(ge=0, le=100)] = 0
