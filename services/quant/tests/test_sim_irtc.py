"""IRTC R3-07: a Monte Carlo from imported per-trade returns never echoes a cost it did not apply.

`extraCostPerTradeR` is a cost in R (units of the initial risk). Returns in % have no R, so the
combination is refused with a plain message instead of being silently ignored (before: P50 and
expectancy identical with 0 and 2.0 R, while the response said `costPerTradeR = 2.0`)."""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from kora_quant.app import create_app
from kora_quant.config import Settings
from kora_quant.sim import service
from kora_quant.sim.models import FromTradesRequest

TRADES = [float(x) for x in np.round(np.random.default_rng(1).normal(0.3, 2.0, 300), 3)]


@pytest.fixture
def client() -> Iterator[TestClient]:
    service.clear_cache()
    with TestClient(create_app(Settings(env="test", live_trading_enabled=False, port=0))) as c:
        yield c


def test_pct_returns_with_an_extra_r_cost_are_refused() -> None:
    with pytest.raises(ValidationError, match="costs in R cannot be applied to % returns"):
        FromTradesRequest(trades=TRADES, trade_unit="pct_return", extra_cost_per_trade_r=2.0)


def test_route_refuses_it_with_a_422(client: TestClient) -> None:
    res = client.post(
        "/mc/from-trades",
        json={"trades": TRADES, "tradeUnit": "pct_return", "extraCostPerTradeR": 2.0},
    )
    assert res.status_code == 422
    assert "costs in R cannot be applied" in res.text


def test_the_echoed_cost_is_the_cost_applied() -> None:
    pct = service.from_trades(FromTradesRequest(trades=TRADES, trade_unit="pct_return", paths=500))
    assert pct.effective.cost_per_trade_r == 0.0
    r0 = service.from_trades(FromTradesRequest(trades=TRADES, paths=500))
    r2 = service.from_trades(
        FromTradesRequest(trades=TRADES, extra_cost_per_trade_r=0.5, paths=500)
    )
    assert r2.effective.cost_per_trade_r == 0.5
    assert r2.expectancy_r == pytest.approx(r0.expectancy_r - 0.5)
