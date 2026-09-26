"""HTTP layer: validation messages, camelCase wire format, warm-up, paper analytics route."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from kora_quant.app import create_app
from kora_quant.config import Settings
from kora_quant.sim import service


@pytest.fixture
def client() -> Iterator[TestClient]:
    service.clear_cache()
    with TestClient(create_app(Settings(env="test", live_trading_enabled=False, port=0))) as c:
        yield c


def test_project_round_trip_camel_case(client: TestClient) -> None:
    res = client.post("/mc/project", json={"paths": 500, "winRatePct": 45, "fatTailProbPct": 3})
    assert res.status_code == 200
    body = res.json()
    assert body["simulated"] is True
    assert body["kind"] == "project"
    assert set(body["bands"]) == {"p5", "p25", "p50", "p75", "p95", "mean"}
    assert body["cache"] == "miss"
    assert (
        client.post(
            "/mc/project", json={"paths": 500, "winRatePct": 45, "fatTailProbPct": 3}
        ).json()["cache"]
        == "hit"
    )


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({"winRatePct": 0}, "greater than or equal to 1"),
        ({"winRatePct": 100}, "less than or equal to 99"),
        ({"paths": 60_000}, "less than or equal to 50000"),
        ({"tradesPerPeriod": 300, "horizonPeriods": 20}, "limit is 5000"),
        (
            {"paths": 50_000, "tradesPerPeriod": 100, "horizonPeriods": 20},
            "Reduce the number of paths",
        ),
        ({"riskPct": 40}, "less than or equal to 25"),
        ({"unknownField": 1}, "Extra inputs"),
    ],
)
def test_project_rejects_silly_values_with_explanations(
    client: TestClient, body: dict[str, object], fragment: str
) -> None:
    res = client.post("/mc/project", json=body)
    assert res.status_code == 422
    assert fragment in res.text


def test_from_trades_validation(client: TestClient) -> None:
    assert client.post("/mc/from-trades", json={"trades": [1.0]}).status_code == 422
    r = client.post("/mc/from-trades", json={"trades": [1, -1, 2], "blockSize": 5})
    assert "block size cannot exceed" in r.text
    r = client.post("/mc/from-trades", json={"trades": [1, -1, -150], "tradeUnit": "pct_return"})
    assert "outside (-100%, 1000%]" in r.text
    r = client.post("/mc/from-trades", json={"trades": [1, -1, 150]})
    assert "outside ±100 R" in r.text
    ok = client.post(
        "/mc/from-trades",
        json={"trades": [1.5, -1, 2, -1], "paths": 200, "source": "backtest_in_sample"},
    )
    assert ok.status_code == 200
    assert {c["code"] for c in ok.json()["realityChecks"]} >= {"in_sample_source", "small_sample"}


def test_paper_analytics_route(client: TestClient) -> None:
    fills = [
        {"id": "a", "orderId": "a", "symbol": "EURUSD", "side": "buy", "qty": "1000",
         "price": "1.1", "fee": "0", "slippage": "0", "ts": "2026-01-01T00:00:00Z"},
        {"id": "b", "orderId": "b", "symbol": "EURUSD", "side": "sell", "qty": "1000",
         "price": "1.2", "fee": "0", "slippage": "0", "ts": "2026-01-02T00:00:00Z"},
    ]  # fmt: skip
    res = client.post(
        "/analytics/paper?simulated_source=true", json={"startingCapital": "1000", "fills": fills}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["simulatedSource"] is True
    assert body["netPnl"] == "100"
    assert body["tradeReturnsPct"] == [10.0]


def test_reality_checks_route(client: TestClient) -> None:
    res = client.post("/reality-checks", json={"winRatePct": 70, "avgWinR": 3, "riskPct": 1})
    assert res.status_code == 200
    assert [c["code"] for c in res.json()["checks"]] == ["implausible_edge"]
