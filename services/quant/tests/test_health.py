from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from kora_quant.app import create_app
from kora_quant.config import Settings, load_settings


def test_health_reports_paper_only() -> None:
    client = TestClient(create_app(Settings(env="test", live_trading_enabled=False, port=0)))
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["environment"] == "PAPER"
    assert body["live_trading_enabled"] is False


def test_live_trading_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LIVE_TRADING_ENABLED", "true")
    with pytest.raises(RuntimeError, match="PAPER only"):
        load_settings()


def test_settings_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LIVE_TRADING_ENABLED", raising=False)
    monkeypatch.setenv("QUANT_PORT", "8123")
    s = load_settings()
    assert s.port == 8123
    assert s.live_trading_enabled is False
