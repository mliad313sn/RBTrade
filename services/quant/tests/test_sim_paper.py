"""Paper-account analytics over hand-computed fill fixtures (all SIMULATED)."""

from __future__ import annotations

from typing import Any

import pytest

from kora_quant.sim.paper import PaperAnalyticsRequest, analyse


def fill(
    i: int,
    side: str,
    qty: str,
    price: str,
    ts: str,
    symbol: str = "EURUSD",
    fee: str = "0",
    slippage: str = "0",
) -> dict[str, Any]:
    return {
        "id": f"f{i}",
        "orderId": f"o{i}",
        "symbol": symbol,
        "side": side,
        "qty": qty,
        "price": price,
        "fee": fee,
        "slippage": slippage,
        "ts": ts,
    }


def req(fills: list[dict[str, Any]], **kw: Any) -> PaperAnalyticsRequest:
    return PaperAnalyticsRequest.model_validate({"startingCapital": "10000", "fills": fills, **kw})


def test_round_trips_fees_and_stats() -> None:
    fills = [
        # long 1000 @ 1.1000 → sell @ 1.1100: +10, fees 1+1
        fill(1, "buy", "1000", "1.1000", "2026-01-01T10:00:00Z", fee="1", slippage="0.5"),
        fill(2, "sell", "1000", "1.1100", "2026-01-01T12:00:00Z", fee="1", slippage="0.5"),
        # short 1000 @ 1.1200 → buy @ 1.1250: -5, fees 1+1
        fill(3, "sell", "1000", "1.1200", "2026-01-01T14:00:00Z", fee="1"),
        fill(4, "buy", "1000", "1.1250", "2026-01-01T18:00:00Z", fee="1"),
    ]
    a = analyse(req(fills))
    assert a.trades == 2
    assert a.wins == 1
    assert a.losses == 1
    assert [t.net_pnl for t in a.closed_trades] == ["8", "-7"]
    assert [t.direction for t in a.closed_trades] == ["long", "short"]
    assert a.net_pnl == "1"
    assert a.ending_equity == "10001"
    assert a.win_rate_pct == 50.0
    assert a.profit_factor == pytest.approx(8 / 7)
    assert a.expectancy == "0.5"
    assert a.avg_win == "8"
    assert a.avg_loss == "-7"
    assert a.total_fees == "4"
    assert a.total_slippage == "1"
    assert a.cost_drag_pct == pytest.approx(5 / 10_000 * 100)
    assert a.cost_share_of_gross_pct == pytest.approx(5 / 8 * 100)
    # exposed 2h + 4h out of 8h
    assert a.exposure_pct == pytest.approx(75.0)
    assert a.trade_returns_pct[0] == pytest.approx(8 / 10_000 * 100)
    assert a.trade_returns_pct[1] == pytest.approx(-7 / 10_008 * 100)
    assert a.open_positions == []
    assert len(a.equity_curve) == 4


def test_fifo_partial_closes_and_flip() -> None:
    fills = [
        fill(1, "buy", "100", "10", "2026-01-01T00:00:00Z", symbol="AAPL"),
        fill(2, "buy", "100", "12", "2026-01-01T01:00:00Z", symbol="AAPL"),
        # sell 150: closes 100 @10 (+500) and 50 @12 (+150) → still long 50 @12
        fill(3, "sell", "150", "15", "2026-01-01T02:00:00Z", symbol="AAPL"),
        # sell 100: closes 50 @12 (+100 at 14) → episode closes (+750); flips short 50 @14
        fill(4, "sell", "100", "14", "2026-01-01T03:00:00Z", symbol="AAPL", fee="2"),
        # cover the short at 13: +50
        fill(5, "buy", "50", "13", "2026-01-01T04:00:00Z", symbol="AAPL"),
    ]
    a = analyse(req(fills))
    assert [(t.direction, t.gross_pnl, t.net_pnl) for t in a.closed_trades] == [
        ("long", "750", "748"),
        ("short", "50", "50"),
    ]
    assert a.ending_equity == "10798"
    assert a.exposure_pct == pytest.approx(100.0)
    assert a.profit_factor is None  # no losing trade


def test_open_position_multiplier_drawdown_and_as_of() -> None:
    fills = [
        fill(1, "buy", "2", "2000", "2026-01-01T00:00:00Z", symbol="XAUUSD"),
        fill(2, "sell", "2", "1990", "2026-01-01T01:00:00Z", symbol="XAUUSD"),  # -10 × 2 × 100
        fill(3, "buy", "1", "1980", "2026-01-01T02:00:00Z", symbol="XAUUSD"),
    ]
    a = analyse(
        req(fills, contractMultipliers={"XAUUSD": "100"}, asOf="2026-01-01T04:00:00Z"),
        simulated_source=True,
    )
    assert a.simulated_source is True
    assert a.net_pnl == "-2000"
    assert a.max_drawdown_pct == pytest.approx(20.0)
    assert a.current_drawdown_pct == pytest.approx(20.0)
    assert [p.symbol for p in a.open_positions] == ["XAUUSD"]
    assert a.open_positions[0].qty == "1"
    assert a.open_positions[0].avg_price == "1980"
    # exposed 0→1h, then 2h→4h (as of) out of 4h
    assert a.exposure_pct == pytest.approx(75.0)


def test_empty_fill_list() -> None:
    a = analyse(req([]))
    assert a.trades == 0
    assert a.win_rate_pct is None
    assert a.expectancy is None
    assert a.exposure_pct is None
    assert a.net_pnl == "0"


def test_fill_schema_rejects_floats_and_naive_times() -> None:
    with pytest.raises(ValueError, match="string"):
        req([fill(1, "buy", "1", "1", "2026-01-01T00:00:00Z") | {"qty": 1.5}])
    with pytest.raises(ValueError, match="timezone"):
        req([fill(1, "buy", "1", "1", "2026-01-01T00:00:00")])
    with pytest.raises(ValueError, match="pattern"):
        req([fill(1, "buy", "-1", "1", "2026-01-01T00:00:00Z")])
