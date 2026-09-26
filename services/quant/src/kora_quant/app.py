"""FastAPI application (goal 01 skeleton: health only; Monte Carlo arrives in goal 05)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from . import __version__
from .config import Settings, load_settings


class Health(BaseModel):
    status: Literal["ok"]
    service: Literal["kora-quant"]
    version: str
    environment: Literal["PAPER"]
    live_trading_enabled: Literal[False]
    time: datetime


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or load_settings()
    app = FastAPI(title="KORA quant", version=__version__, docs_url="/docs")

    @app.get("/health", response_model=Health)
    def health() -> Health:
        return Health(
            status="ok",
            service="kora-quant",
            version=__version__,
            environment="PAPER",
            live_trading_enabled=cfg.live_trading_enabled,
            time=datetime.now(UTC),
        )

    return app


app = create_app()
