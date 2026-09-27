"""`/scanner/run`: one call scans the universe, labels emerging trends, nowcasts the regime and
(optionally) runs the walk-forward forecasts, all from one panel built from the api's SIMULATED
history. Detectors return numbers only."""

from __future__ import annotations

import math
import time
from typing import Annotated, Any

from pydantic import Field, model_validator

from ..bt.models import BarsWire
from ..sim.models import Wire
from . import detectors
from .forecast import FORECAST_FEATURES, ForecastConfig, forecast
from .guard import verify_scan_point_in_time
from .panel import ScanConfig, build_panel

MAX_INSTRUMENTS = 2_000
MAX_WIDTH = 5_000


class InstrumentWire(Wire):
    symbol: Annotated[str, Field(min_length=1, max_length=32)]
    sector: Annotated[str, Field(min_length=1, max_length=40)]
    region: Annotated[str, Field(min_length=1, max_length=40)]
    bars: BarsWire
    events: Annotated[list[int] | None, Field(max_length=5_000)] = None
    cost_fraction: Annotated[float, Field(ge=0, le=0.2)] = 0.0


class ConfigWire(Wire):
    fast: Annotated[int, Field(ge=3, le=200)] = 20
    slow: Annotated[int, Field(ge=4, le=1_000)] = 100
    adx: Annotated[int, Field(ge=2, le=100)] = 14
    breakout: Annotated[int, Field(ge=2, le=200)] = 20
    season: Annotated[int, Field(ge=2, le=100)] = 20

    @model_validator(mode="after")
    def _order(self) -> ConfigWire:
        if self.slow <= self.fast:
            raise ValueError("slow must be longer than fast")
        return self


class HorizonWire(Wire):
    label: Annotated[str, Field(pattern=r"^[0-9a-z]{1,8}$")]
    bars: Annotated[int, Field(ge=1, le=2_000)]


class ForecastSpec(Wire):
    horizons: Annotated[list[HorizonWire], Field(min_length=1, max_length=6)]
    folds: Annotated[int, Field(ge=2, le=12)] = 5
    min_train: Annotated[int, Field(ge=50, le=10_000)] = 200
    l2: Annotated[float, Field(gt=0, le=1_000)] = 1.0
    symbols: Annotated[list[str] | None, Field(max_length=MAX_INSTRUMENTS)] = None


class ScanRequest(Wire):
    timeframe: Annotated[str, Field(pattern=r"^[0-9]{1,3}[smhDW]$")]
    tf_seconds: Annotated[int, Field(ge=1, le=7 * 86_400)]
    instruments: Annotated[list[InstrumentWire], Field(min_length=1, max_length=MAX_INSTRUMENTS)]
    config: ConfigWire = ConfigWire()
    width: Annotated[int, Field(ge=10, le=MAX_WIDTH)] = 1_000
    guard: bool = True
    guard_checkpoints: Annotated[int, Field(ge=1, le=20)] = 4
    forecast: ForecastSpec | None = None


def _num(x: float, digits: int = 6) -> float | None:
    return round(x, digits) if math.isfinite(x) else None


def run_scan(req: ScanRequest) -> dict[str, Any]:
    started = time.perf_counter()
    cfg = ScanConfig(
        fast=req.config.fast,
        slow=req.config.slow,
        adx=req.config.adx,
        breakout=req.config.breakout,
        season=req.config.season,
    )
    ins = req.instruments
    panel = build_panel(
        [i.symbol for i in ins],
        [(i.bars.t, i.bars.o, i.bars.h, i.bars.l, i.bars.c, i.bars.v) for i in ins],
        req.tf_seconds * 1000,
        [i.sector for i in ins],
        [i.region for i in ins],
        [i.events or [] for i in ins],
        width=min(req.width, max(len(i.bars.t) for i in ins)),
    )
    feats = detectors.compute(panel, cfg)
    checkpoints = (
        verify_scan_point_in_time(panel, cfg, feats, req.guard_checkpoints) if req.guard else 0
    )
    scan_ms = (time.perf_counter() - started) * 1000
    last = detectors.last_column(feats)
    wanted = set(req.forecast.symbols) if req.forecast and req.forecast.symbols else None
    out: list[dict[str, Any]] = []
    for i, inst in enumerate(ins):
        row = last[i]
        bar_ts = int(panel.t[i, -1])
        trend = detectors.classify(row)
        item: dict[str, Any] = {
            "symbol": inst.symbol,
            "barTs": bar_ts if bar_ts > 0 else None,
            "bars": int(sum(1 for x in panel.t[i] if x > 0)),
            "features": {k: _num(v) for k, v in row.items()},
            "trend": None if trend is None else {"kind": trend[0], "score": trend[1]},
            "forecasts": [],
        }
        if req.forecast and (wanted is None or inst.symbol in wanted):
            x = detectors.matrix(feats, FORECAST_FEATURES, i)
            for hz in req.forecast.horizons:
                res = forecast(
                    x,
                    panel.c[i],
                    list(FORECAST_FEATURES),
                    ForecastConfig(
                        horizon=hz.bars,
                        cost=inst.cost_fraction,
                        folds=req.forecast.folds,
                        min_train=req.forecast.min_train,
                        l2=req.forecast.l2,
                    ),
                )
                # Out-of-sample forecasts for the track record (IRTC R3-03): only those made at a
                # bar close on the fixed calendar grid (a multiple of h × timeframe since the epoch)
                # and at least h bars apart. Every later scan replays the same prediction times,
                # so re-scans deduplicate on insert instead of adding a new overlapping phase.
                oos: list[dict[str, Any]] = []
                grid = hz.bars * panel.tf_ms
                last_t = -(10**9)
                for pt in res.oos:
                    made = int(panel.t[i, pt.t]) + panel.tf_ms
                    if made % grid != 0 or pt.t - last_t < hz.bars:
                        continue
                    last_t = pt.t
                    resolve = pt.t + hz.bars
                    oos.append(
                        {
                            "ts": made,
                            "resolvedTs": int(panel.t[i, resolve]) + panel.tf_ms,
                            "pUp": round(pt.p_up, 6),
                            "pDirection": round(max(pt.p_up, 1 - pt.p_up), 6),
                            "direction": "up" if pt.p_up >= 0.5 else "down",
                            "outcome": pt.outcome,
                            "netReturn": round(pt.net, 8),
                        }
                    )
                latest = None
                if res.latest is not None:
                    latest = {**res.latest, "ts": int(panel.t[i, -1]) + panel.tf_ms}
                    latest.pop("t", None)
                item["forecasts"].append(
                    {
                        "horizon": hz.label,
                        "horizonBars": hz.bars,
                        "status": res.status,
                        "features": res.features,
                        "skill": res.skill,
                        "latest": latest,
                        "oos": oos,
                    }
                )
        out.append(item)
    return {
        "simulated": True,
        "timeframe": req.timeframe,
        "instruments": out,
        "featureNames": list(detectors.FEATURES),
        "guard": {"enabled": req.guard, "checkpoints": checkpoints, "passed": True},
        "scanMs": round(scan_ms, 1),
        "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
    }
