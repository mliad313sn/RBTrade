"""Pydantic mirror of the `kora.strategy` v1 DSL (packages/domain/src/strategy/dsl.ts).

The api validates every definition with the zod schema first; this mirror validates again
(defence in
depth) and gives the evaluator typed access. A cross-language fixture test loads the TypeScript
templates and JSON Schema (`tests/fixtures/strategy_templates.json`) to keep both sides in step.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Dsl(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class ParamRef(Dsl):
    param: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,31}$")]


Num = float | ParamRef

IndicatorName = Literal[
    "close",
    "open",
    "high",
    "low",
    "volume",
    "ema",
    "sma",
    "rsi",
    "atr",
    "adx",
    "roc",
    "highest",
    "lowest",
    "realised_vol",
]


class IndicatorOperand(Dsl):
    kind: Literal["indicator"]
    name: IndicatorName
    period: Num | None = None


class ConstOperand(Dsl):
    kind: Literal["const"]
    value: Num


Operand = Annotated[IndicatorOperand | ConstOperand, Field(discriminator="kind")]


class CompareCondition(Dsl):
    type: Literal["compare"]
    id: str | None = None
    left: Operand
    op: Literal["gt", "gte", "lt", "lte"]
    right: Operand


class CrossCondition(Dsl):
    type: Literal["cross"]
    id: str | None = None
    left: Operand
    direction: Literal["above", "below"]
    right: Operand


class SessionWindowCondition(Dsl):
    type: Literal["session_window"]
    id: str | None = None
    label: str | None = None
    timezone: str
    start: Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
    end: Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
    days: list[Annotated[int, Field(ge=1, le=7)]] | None = None


class VenueOpenCondition(Dsl):
    type: Literal["venue_open"]
    id: str | None = None


class NoEventCondition(Dsl):
    type: Literal["no_event"]
    id: str | None = None
    within_minutes: Num
    impact: Literal["high"] = "high"


class AiRegimeCondition(Dsl):
    type: Literal["ai_regime"]
    id: str | None = None
    regime: Literal["trending", "ranging", "volatile"]
    min_probability: Num
    when_unavailable: Literal["ignore", "block"] = "ignore"


Condition = Annotated[
    CompareCondition
    | CrossCondition
    | SessionWindowCondition
    | VenueOpenCondition
    | NoEventCondition
    | AiRegimeCondition,
    Field(discriminator="type"),
]


class AtrStop(Dsl):
    kind: Literal["atr"]
    multiple: Num
    period: Num


class PercentStop(Dsl):
    kind: Literal["percent"]
    pct: Num


class RTarget(Dsl):
    kind: Literal["r"]
    multiple: Num


Stop = Annotated[AtrStop | PercentStop, Field(discriminator="kind")]
Target = Annotated[AtrStop | RTarget | PercentStop, Field(discriminator="kind")]


class Trailing(Dsl):
    after_r: Num
    kind: Literal["atr"]
    multiple: Num
    period: Num


class ExitBlock(Dsl):
    stop: Stop
    target: Target | None = None
    trailing: Trailing | None = None
    time_stop_bars: Num | None = None
    conditions: Annotated[list[Condition], Field(max_length=8)] = []


class RiskPctSize(Dsl):
    kind: Literal["risk_pct"]
    pct: Num
    max_open_positions: Annotated[int, Field(ge=1, le=20)]


class FixedSize(Dsl):
    kind: Literal["fixed"]
    qty: Annotated[str, Field(pattern=r"^\d+(\.\d+)?$")]
    max_open_positions: Annotated[int, Field(ge=1, le=20)]


class VolTargetSize(Dsl):
    kind: Literal["vol_target"]
    annual_vol_pct: Num
    lookback: Num
    max_open_positions: Annotated[int, Field(ge=1, le=20)]


Size = Annotated[RiskPctSize | FixedSize | VolTargetSize, Field(discriminator="kind")]


class ParamSpec(Dsl):
    value: float
    min: float | None = None
    max: float | None = None
    step: float | None = None
    integer: bool = False
    label: str | None = None


class Universe(Dsl):
    symbols: Annotated[list[str], Field(min_length=1, max_length=10)]
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1D"]


class EntryBlock(Dsl):
    side: Literal["long", "short"]
    conditions: Annotated[list[Condition], Field(min_length=1, max_length=8)]


class StrategyDefinition(Dsl):
    schema_: Annotated[Literal["kora.strategy"], Field(alias="schema")]
    schema_version: Literal[1]
    name: Annotated[str, Field(min_length=1, max_length=60)]
    description: str | None = None
    universe: Universe
    params: dict[str, ParamSpec] = {}
    entry: EntryBlock
    filters: Annotated[list[Condition], Field(max_length=8)] = []
    exit: ExitBlock
    size: Size


TIMEFRAME_SECONDS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1D": 86400,
}


class Params:
    """Resolves numbers and parameter references (with overrides for sweeps)."""

    def __init__(self, spec: dict[str, ParamSpec], overrides: dict[str, float] | None = None):
        self._values = {k: v.value for k, v in spec.items()}
        for k, v in (overrides or {}).items():
            if k not in self._values:
                raise ValueError(f'Unknown parameter "{k}" in the overrides')
            self._values[k] = v

    @property
    def values(self) -> dict[str, float]:
        return dict(self._values)

    def num(self, v: Num | None) -> float:
        if v is None:
            raise ValueError("missing number")
        if isinstance(v, ParamRef):
            if v.param not in self._values:
                raise ValueError(f'Unknown parameter "{v.param}"')
            return self._values[v.param]
        return float(v)

    def period(self, v: Num | None) -> int:
        n = self.num(v)
        if not float(n).is_integer() or n < 1 or n > 500:
            raise ValueError(f"Periods must be whole numbers from 1 to 500 (got {n})")
        return int(n)
