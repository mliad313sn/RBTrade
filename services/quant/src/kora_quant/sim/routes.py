"""HTTP routes for the gain simulator. The api (apps/api/src/sim) is the only intended caller."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from . import service
from .models import (
    FromTradesRequest,
    ProjectRequest,
    RealityCheckRequest,
    RealityCheckResponse,
    SimResult,
)
from .paper import PaperAnalytics, PaperAnalyticsRequest, analyse

log = logging.getLogger("kora_quant.sim")
router = APIRouter(tags=["simulator"])


def _log_run(result: SimResult) -> None:
    log.info(
        "sim.run kind=%s hash=%s cache=%s paths=%d trades=%d elapsed_ms=%.1f",
        result.kind,
        result.input_hash[:12],
        result.cache,
        result.paths,
        result.trades_per_path,
        result.elapsed_ms,
    )


@router.post("/mc/project", response_model=SimResult, response_model_by_alias=True)
async def mc_project(req: ProjectRequest) -> SimResult:
    """Monte Carlo projection of a parametric edge (costs included by default)."""
    result = await run_in_threadpool(service.project, req)
    _log_run(result)
    return result


@router.post("/mc/from-trades", response_model=SimResult, response_model_by_alias=True)
async def mc_from_trades(req: FromTradesRequest) -> SimResult:
    """Circular moving-block bootstrap of an actual trade list (backtest or paper account)."""
    result = await run_in_threadpool(service.from_trades, req)
    _log_run(result)
    return result


@router.post("/analytics/paper", response_model=PaperAnalytics, response_model_by_alias=True)
def paper_analytics(req: PaperAnalyticsRequest, simulated_source: bool = False) -> PaperAnalytics:
    """Realised equity curve and trade statistics from paper fills."""
    try:
        return analyse(req, simulated_source=simulated_source)
    except ValueError as exc:  # pragma: no cover - guarded by request validation
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/reality-checks", response_model=RealityCheckResponse, response_model_by_alias=True)
def reality_checks(req: RealityCheckRequest) -> RealityCheckResponse:
    """Evaluates the reality-check rules without running a simulation."""
    return service.reality_checks(req)
