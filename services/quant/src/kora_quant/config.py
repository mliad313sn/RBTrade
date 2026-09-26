"""Settings from environment only (no secrets in code)."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    env: str
    live_trading_enabled: bool
    port: int


def load_settings() -> Settings:
    live = os.environ.get("LIVE_TRADING_ENABLED", "false").lower() in {"1", "true"}
    if live:
        raise RuntimeError("LIVE_TRADING_ENABLED=true is not supported: KORA runs in PAPER only.")
    return Settings(
        env=os.environ.get("KORA_ENV", "dev"),
        live_trading_enabled=False,
        port=int(os.environ.get("QUANT_PORT", "8000")),
    )
