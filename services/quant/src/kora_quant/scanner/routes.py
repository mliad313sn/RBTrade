"""HTTP route for the market intelligence scanner (the api's intel module is the only caller)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from ..bt.evaluate import LookAheadError
from .service import ScanRequest, run_scan

log = logging.getLogger("kora_quant.scanner")
router = APIRouter(prefix="/scanner", tags=["market intelligence"])


@router.post("/run")
async def scanner_run(req: ScanRequest) -> dict[str, Any]:
    """Detectors (features only), emerging-trend labels, regime nowcast and optional point-in-time
    walk-forward forecasts for every instrument in the request."""
    try:
        out = await run_in_threadpool(run_scan, req)
    except LookAheadError as exc:
        log.error("scanner look-ahead guard: %s", exc)
        raise HTTPException(
            status_code=422, detail=[{"loc": ["body"], "msg": str(exc), "type": "look_ahead"}]
        ) from exc
    log.info("scanner.run instruments=%s elapsed_ms=%s", len(req.instruments), out.get("elapsedMs"))
    return out
