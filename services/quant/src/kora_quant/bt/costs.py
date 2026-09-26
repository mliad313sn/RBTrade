"""Cost and fill model shared with the paper engine (goal 03).

The api builds a `CostModel` per symbol from the same registry rows the paper engine reads
(`fee_schedules`, `asset_class_trading`, the instrument grid and multiplier) and sends it with every
request; nothing here has its own fee table. Formulas mirror `packages/domain/src/trading/costs.ts`:

- commission = notional × bps / 10,000 + |qty| × per-unit, floored at the minimum, rounded to the
  quote currency's minor unit;
- a taker fill crosses half the spread and pays the volatility term `ceil_tick(volFactor × |Δmid|)`
  (the paper engine's depth walk at level 0; deeper levels add `impactTicks` per level, which the
  bar
  model does not see and which is part of the parity tolerance);
- overnight funding per 21:00 UTC roll, ACT/360, signed from the customer's view.
"""

from __future__ import annotations

import math
from decimal import ROUND_FLOOR, ROUND_HALF_EVEN, Decimal
from typing import Annotated, Literal

from pydantic import Field

from ..sim.models import Wire

EPS = 1e-6  # in ticks: float noise below a millionth of a tick is ignored


class CostModel(Wire):
    tick_size: Annotated[float, Field(gt=0)]
    price_precision: Annotated[int, Field(ge=0, le=12)]
    qty_step: Annotated[str, Field(pattern=r"^\d+(\.\d+)?$")]
    min_qty: Annotated[str, Field(pattern=r"^\d+(\.\d+)?$")]
    multiplier: Annotated[float, Field(gt=0)] = 1.0
    commission_bps: Annotated[float, Field(ge=0)] = 0.0
    commission_per_unit: Annotated[float, Field(ge=0)] = 0.0
    commission_min: Annotated[float, Field(ge=0)] = 0.0
    swap_long_bps: float = 0.0
    swap_short_bps: float = 0.0
    impact_ticks: Annotated[float, Field(ge=0)] = 0.0
    vol_factor: Annotated[float, Field(ge=0)] = 0.0
    spread_ticks: Annotated[float, Field(ge=0)] = 0.0
    fx_to_base: Annotated[float, Field(gt=0)] = 1.0
    currency_decimals: Annotated[int, Field(ge=0, le=4)] = 2
    simulated: bool = True
    source: Literal["registry"] = "registry"

    @property
    def half_spread(self) -> float:
        return self.spread_ticks * self.tick_size / 2.0


def round_tick(x: float, tick: float, mode: Literal["up", "down", "nearest"]) -> float:
    q = x / tick
    if mode == "up":
        n = math.ceil(q - EPS)
    elif mode == "down":
        n = math.floor(q + EPS)
    else:
        n = math.floor(q + 0.5 + EPS)
    return n * tick


def fmt_price(x: float, cm: CostModel) -> str:
    return f"{round_tick(x, cm.tick_size, 'nearest'):.{cm.price_precision}f}"


def quote(mid: float, cm: CostModel) -> tuple[float, float]:
    """Bid/ask around a mid on the tick grid (bid rounded down, ask up), as the fixtures and feed
    do."""
    return (
        round_tick(mid - cm.half_spread, cm.tick_size, "down"),
        round_tick(mid + cm.half_spread, cm.tick_size, "up"),
    )


def vol_term(move: float, cm: CostModel) -> float:
    return round_tick(abs(move) * cm.vol_factor, cm.tick_size, "up")


def taker_price(side: Literal["buy", "sell"], mid: float, move: float, cm: CostModel) -> float:
    """Market fill at the touch plus the volatility term (level-0 depth walk)."""
    bid, ask = quote(mid, cm)
    v = vol_term(move, cm)
    return ask + v if side == "buy" else max(cm.tick_size, bid - v)


def commission(qty: float, price: float, cm: CostModel) -> float:
    raw = (
        abs(qty) * price * cm.multiplier * cm.commission_bps / 10_000
        + abs(qty) * cm.commission_per_unit
    )
    c = max(raw, cm.commission_min)
    # Minor-unit rounding, half-even, like the domain's `roundMoney`.
    minor = Decimal(1).scaleb(-cm.currency_decimals)
    return float(Decimal(repr(c)).quantize(minor, rounding=ROUND_HALF_EVEN))


def swap(qty_signed: float, mark: float, cm: CostModel, nights: int) -> float:
    if qty_signed == 0 or nights <= 0:
        return 0.0
    bps = cm.swap_long_bps if qty_signed > 0 else cm.swap_short_bps
    return abs(qty_signed) * mark * cm.multiplier * bps / 10_000 * nights / 360


def snap_qty(q: float, cm: CostModel) -> Decimal:
    """Floors a quantity onto the registry qty grid (Decimal, exact)."""
    if not math.isfinite(q) or q <= 0:
        return Decimal(0)
    step = Decimal(cm.qty_step)
    return (Decimal(repr(q)) / step).to_integral_value(rounding=ROUND_FLOOR) * step
