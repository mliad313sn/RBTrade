"""Paper-account analytics: a pure function over a list of fills (schema = @kora/domain `Fill`).

Money is Decimal end-to-end (master goal); only ratios are floats. Conventions:
- A *trade* is a position episode per symbol: from flat to flat. A fill that flips the position
  closes the episode and opens a new one at the same price with the remaining quantity.
- Lots are matched FIFO. Realised P&L = (exit − entry) × qty × multiplier, in account currency.
  Multipliers come from `contractMultipliers` (default 1: quote currency = account currency).
- `fee` is cash paid on the fill and reduces equity. `slippage` is the currency cost already
  embedded in the fill price: it is *not* subtracted again, but it counts in the cost drag.
- A flipping fill's fee is charged to the episode it closes.
- Open positions have no marks here (goal 03 supplies them), so equity is realised only.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import Field, field_validator

from ..money import KORA_CONTEXT, dec
from .models import Wire

DecStr = Annotated[str, Field(pattern=r"^-?\d{1,18}(\.\d{1,18})?$")]
PosDecStr = Annotated[str, Field(pattern=r"^\d{1,18}(\.\d{1,18})?$")]
ZERO = Decimal(0)


class FillIn(Wire):
    """Mirror of `Fill` in packages/domain/src/types.ts (decimal strings on the wire)."""

    id: Annotated[str, Field(min_length=1, max_length=64)]
    order_id: Annotated[str, Field(min_length=1, max_length=64)]
    symbol: Annotated[str, Field(pattern=r"^[A-Z0-9._-]{1,20}$")]
    side: Literal["buy", "sell"]
    qty: PosDecStr
    price: PosDecStr
    fee: PosDecStr
    slippage: PosDecStr
    ts: datetime

    @field_validator("ts")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("ts must include a timezone (UTC)")
        return v


class PaperAnalyticsRequest(Wire):
    starting_capital: PosDecStr
    fills: Annotated[list[FillIn], Field(max_length=100_000)]
    contract_multipliers: Annotated[dict[str, PosDecStr], Field(default_factory=dict)]
    as_of: datetime | None = None


class EquityPoint(Wire):
    ts: datetime
    equity: str
    drawdown_pct: float


class ClosedTrade(Wire):
    symbol: str
    direction: Literal["long", "short"]
    opened_at: datetime
    closed_at: datetime
    gross_pnl: str
    fees: str
    net_pnl: str
    return_pct: float


class OpenPosition(Wire):
    symbol: str
    qty: str
    avg_price: str


class PaperAnalytics(Wire):
    simulated_source: bool
    starting_capital: str
    ending_equity: str
    net_pnl: str
    equity_curve: list[EquityPoint]
    max_drawdown_pct: float
    current_drawdown_pct: float
    trades: int
    wins: int
    losses: int
    win_rate_pct: float | None
    profit_factor: float | None
    expectancy: str | None
    expectancy_pct: float | None
    avg_win: str | None
    avg_loss: str | None
    total_fees: str
    total_slippage: str
    cost_drag_pct: float
    cost_share_of_gross_pct: float | None
    exposure_pct: float | None
    closed_trades: list[ClosedTrade]
    trade_returns_pct: list[float]
    open_positions: list[OpenPosition]


@dataclass
class _Lot:
    qty: Decimal  # signed
    price: Decimal


@dataclass
class _Episode:
    opened_at: datetime
    open_equity: Decimal
    gross: Decimal = ZERO
    fees: Decimal = ZERO


@dataclass
class _Book:
    lots: deque[_Lot] = field(default_factory=deque)
    episode: _Episode | None = None

    @property
    def position(self) -> Decimal:
        return sum((lot.qty for lot in self.lots), ZERO)


def _q(x: Decimal) -> str:
    return format(x.quantize(Decimal("0.00000001"), context=KORA_CONTEXT).normalize(), "f")


def _ratio(num: Decimal, den: Decimal) -> float:
    return float(KORA_CONTEXT.divide(num, den))


def analyse(req: PaperAnalyticsRequest, simulated_source: bool = False) -> PaperAnalytics:
    capital = dec(req.starting_capital)
    if capital <= 0:
        raise ValueError("starting capital must be positive")
    mult = {k: dec(v) for k, v in req.contract_multipliers.items()}
    fills = sorted(req.fills, key=lambda f: (f.ts, f.id))
    books: dict[str, _Book] = {}
    equity = capital
    peak = capital
    max_dd = 0.0
    fees_total = ZERO
    slip_total = ZERO
    curve: list[EquityPoint] = []
    closed: list[ClosedTrade] = []
    exposed_since: datetime | None = None
    exposed_seconds = 0.0

    for f in fills:
        book = books.setdefault(f.symbol, _Book())
        qty, price, fee = dec(f.qty), dec(f.price), dec(f.fee)
        m = mult.get(f.symbol, Decimal(1))
        signed = qty if f.side == "buy" else -qty
        was_flat_everywhere = all(b.position == 0 for b in books.values())
        fees_total += fee
        slip_total += dec(f.slippage)
        if book.episode is None:
            book.episode = _Episode(opened_at=f.ts, open_equity=equity)
        book.episode.fees += fee
        equity -= fee

        remaining = signed
        pos = book.position
        if pos != 0 and (pos > 0) != (signed > 0):
            while remaining != 0 and book.lots:
                lot = book.lots[0]
                take = min(abs(lot.qty), abs(remaining))
                direction = Decimal(1) if lot.qty > 0 else Decimal(-1)
                pnl = (price - lot.price) * take * direction * m
                book.episode.gross += pnl
                equity += pnl
                lot.qty -= take * direction
                remaining += take * direction
                if lot.qty == 0:
                    book.lots.popleft()
            if not book.lots:
                ep = book.episode
                net = ep.gross - ep.fees
                closed.append(
                    ClosedTrade(
                        symbol=f.symbol,
                        direction="long" if pos > 0 else "short",
                        opened_at=ep.opened_at,
                        closed_at=f.ts,
                        gross_pnl=_q(ep.gross),
                        fees=_q(ep.fees),
                        net_pnl=_q(net),
                        return_pct=_ratio(net, ep.open_equity) * 100.0
                        if ep.open_equity > 0
                        else 0.0,
                    )
                )
                book.episode = (
                    _Episode(opened_at=f.ts, open_equity=equity) if remaining != 0 else None
                )
        if remaining != 0:
            book.lots.append(_Lot(qty=remaining, price=price))

        flat_everywhere = all(b.position == 0 for b in books.values())
        if was_flat_everywhere and not flat_everywhere:
            exposed_since = f.ts
        elif not was_flat_everywhere and flat_everywhere and exposed_since is not None:
            exposed_seconds += (f.ts - exposed_since).total_seconds()
            exposed_since = None

        peak = max(peak, equity)
        dd = _ratio(peak - equity, peak) if peak > 0 else 0.0
        max_dd = max(max_dd, dd)
        curve.append(EquityPoint(ts=f.ts, equity=_q(equity), drawdown_pct=dd * 100.0))

    exposure: float | None = None
    if fills:
        end = req.as_of or fills[-1].ts
        if exposed_since is not None:
            exposed_seconds += max((end - exposed_since).total_seconds(), 0.0)
        span = (end - fills[0].ts).total_seconds()
        exposure = min(exposed_seconds / span, 1.0) * 100.0 if span > 0 else None

    nets = [dec(t.net_pnl) for t in closed]
    wins = [n for n in nets if n > 0]
    losses = [n for n in nets if n < 0]
    gross_win = sum(wins, ZERO)
    gross_loss = -sum(losses, ZERO)
    costs = fees_total + slip_total
    n = len(closed)
    return PaperAnalytics(
        simulated_source=simulated_source,
        starting_capital=_q(capital),
        ending_equity=_q(equity),
        net_pnl=_q(equity - capital),
        equity_curve=curve,
        max_drawdown_pct=max_dd * 100.0,
        current_drawdown_pct=(_ratio(peak - equity, peak) * 100.0) if peak > 0 else 0.0,
        trades=n,
        wins=len(wins),
        losses=len(losses),
        win_rate_pct=(len(wins) / n * 100.0) if n else None,
        profit_factor=_ratio(gross_win, gross_loss) if gross_loss > 0 else None,
        expectancy=_q(KORA_CONTEXT.divide(sum(nets, ZERO), Decimal(n))) if n else None,
        expectancy_pct=(sum(t.return_pct for t in closed) / n) if n else None,
        avg_win=_q(KORA_CONTEXT.divide(gross_win, Decimal(len(wins)))) if wins else None,
        avg_loss=_q(KORA_CONTEXT.divide(-gross_loss, Decimal(len(losses)))) if losses else None,
        total_fees=_q(fees_total),
        total_slippage=_q(slip_total),
        cost_drag_pct=_ratio(costs, capital) * 100.0,
        cost_share_of_gross_pct=_ratio(costs, gross_win) * 100.0 if gross_win > 0 else None,
        exposure_pct=exposure,
        closed_trades=closed,
        trade_returns_pct=[t.return_pct for t in closed],
        open_positions=[
            OpenPosition(
                symbol=s,
                qty=_q(b.position),
                avg_price=_q(
                    KORA_CONTEXT.divide(
                        sum((lot.qty * lot.price for lot in b.lots), ZERO), b.position
                    )
                ),
            )
            for s, b in sorted(books.items())
            if b.position != 0
        ],
    )
