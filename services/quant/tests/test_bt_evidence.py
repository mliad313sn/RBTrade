"""IRTC R3-02: on pure noise, the promotion evidence (the holdout's deflated Sharpe with the
counted trials) must pass no more often than its nominal false-positive rate, while the old raw
point-estimate gate (OOS Sharpe >= 0.8) passes far more often. SIMULATED random walks only."""

from __future__ import annotations

from typing import Any

from bt_helpers import SYN_COSTS, bars_wire, ema_cross_definition
from kora_quant.bt.models import BacktestRunRequest
from kora_quant.bt.research import backtest
from test_bt_selection import random_walk

SEEDS = range(20)
N_BARS = 9_000  # 375 days of 1h bars: the 30 % holdout holds about 112 daily observations


def _run(seed: int, **extra: Any) -> dict[str, Any]:
    rows = random_walk(N_BARS, 500 + seed)
    return backtest(
        BacktestRunRequest.model_validate(
            {
                "definition": ema_cross_definition(),
                "data": [{"symbol": "SYN", "bars": bars_wire(rows), "costs": SYN_COSTS}],
                "capital": 100_000.0,
                **extra,
            }
        )
    )


def test_noise_rarely_passes_the_deflated_holdout_gate() -> None:
    dsr_pass = raw_pass = 0
    for seed in SEEDS:
        out = _run(seed, trials={"count": 15, "periodSharpes": [-0.05, 0.02, 0.06, -0.03]})
        h = out["overfitting"]["holdout"]
        assert h["basis"] == "out_of_sample_holdout" and h["trials"] == 16
        assert h["observations"] >= 90
        if h["dsr"] is not None and h["dsr"] >= 0.95:
            dsr_pass += 1
        s = out["metrics"]["outOfSample"]["sharpe"]
        if s is not None and s >= 0.8:
            raw_pass += 1
    # Nominal one-sided 5 % (fewer with 16 trials): P(>= 3 of 20) < 8 % even at 5 %.
    assert dsr_pass <= 2, (dsr_pass, raw_pass)


def test_more_counted_trials_never_raise_the_holdout_dsr() -> None:
    one = _run(3)["overfitting"]["holdout"]
    many = _run(3, trials={"count": 99, "periodSharpes": [-0.1, 0.1, 0.05, -0.02, 0.2]})[
        "overfitting"
    ]["holdout"]
    assert one["trials"] == 1 and many["trials"] == 100
    assert one["dsr"] is not None and many["dsr"] is not None
    assert many["dsr"] <= one["dsr"]
