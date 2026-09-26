"""HTTP routes for the research engine. The api (apps/api/src/strategies, robots) is the only
caller."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from . import research
from .evaluate import LookAheadError
from .models import (
    BacktestRunRequest,
    OptimiseRequest,
    SensitivityRequest,
    SignalRequest,
    WalkForwardRequest,
)

log = logging.getLogger("kora_quant.bt")
router = APIRouter(prefix="/bt", tags=["robot research"])
Req = TypeVar("Req")


async def _call(kind: str, fn: Callable[[Req], dict[str, Any]], req: Req) -> dict[str, Any]:
    try:
        out = await run_in_threadpool(fn, req)
    except LookAheadError as exc:
        log.error("bt.%s look-ahead guard: %s", kind, exc)
        raise HTTPException(
            status_code=422, detail=[{"loc": ["body"], "msg": str(exc), "type": "look_ahead"}]
        ) from exc
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail=[
                {"loc": ["body", "definition", *e["loc"]], "msg": e["msg"], "type": e["type"]}
                for e in exc.errors()
            ],
        ) from exc
    except research.ResearchError as exc:
        raise HTTPException(
            status_code=422, detail=[{"loc": ["body"], "msg": str(exc), "type": "research"}]
        ) from exc
    log.info("bt.%s elapsed_ms=%s", kind, out.get("elapsedMs"))
    return out


@router.post("/run")
async def bt_run(req: BacktestRunRequest) -> dict[str, Any]:
    """Backtest with the in-sample / out-of-sample split, metrics, warnings and deflated Sharpe."""
    return await _call("run", research.backtest, req)


@router.post("/walk-forward")
async def bt_walk_forward(req: WalkForwardRequest) -> dict[str, Any]:
    """Anchored or rolling walk-forward (optionally re-optimising each fold in-sample)."""
    return await _call("walk_forward", research.walk_forward, req)


@router.post("/optimise")
async def bt_optimise(req: OptimiseRequest) -> dict[str, Any]:
    """Grid or random search with a hard cap, ranked by out-of-sample Sharpe."""
    return await _call("optimise", research.optimise, req)


@router.post("/sensitivity")
async def bt_sensitivity(req: SensitivityRequest) -> dict[str, Any]:
    """Out-of-sample Sharpe over a grid of two parameters (the heatmap)."""
    return await _call("sensitivity", research.sensitivity, req)


@router.post("/signal")
async def bt_signal(req: SignalRequest) -> dict[str, Any]:
    """Live decision for the bot runner on the last closed bar (same evaluator as the
    backtester)."""
    return await _call("signal", research.signal, req)
