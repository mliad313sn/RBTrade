"""FastAPI application: health, the gain simulator (goal 05), robot research (goal 06) and the
market intelligence scanner (goal 07B)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Literal

from fastapi import FastAPI
from opentelemetry.sdk.trace import TracerProvider
from pydantic import BaseModel

from . import __version__
from .bt.routes import router as bt_router
from .config import Settings, load_settings
from .scanner.kernels import warm_up as warm_up_scanner
from .scanner.routes import router as scanner_router
from .sim.engine import warm_up
from .sim.routes import router as sim_router
from .tracing import build_provider, instrument


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
    warm_up_scanner()
    yield


def create_app(
    settings: Settings | None = None, tracer_provider: TracerProvider | None = None
) -> FastAPI:
    cfg = settings or load_settings()
    app = FastAPI(title="KORA quant", version=__version__, docs_url="/docs", lifespan=lifespan)
    instrument(app, tracer_provider or build_provider())

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
    app.include_router(bt_router)
    app.include_router(scanner_router)
    return app


app = create_app()
