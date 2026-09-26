"""FastAPI application: health plus the gain simulator (goal 05)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from . import __version__
from .config import Settings, load_settings
from .sim.engine import warm_up
from .sim.routes import router as sim_router


class Health(BaseModel):
    status: Literal["ok"]
    service: Literal["kora-quant"]
    version: str
    environment: Literal["PAPER"]
    live_trading_enabled: Literal[False]
    time: datetime


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    warm_up()  # compile (or load cached) numba kernels before the first request
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or load_settings()
    app = FastAPI(title="KORA quant", version=__version__, docs_url="/docs", lifespan=lifespan)

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

    app.include_router(sim_router)
    return app


app = create_app()
