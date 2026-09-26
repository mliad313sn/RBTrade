"""Every reality-check rule fires on its fixture and stays silent on the matching clean fixture."""

from __future__ import annotations

from dataclasses import replace

import pytest

from kora_quant.sim.models import RealityCheckRequest
from kora_quant.sim.reality import CheckInput, evaluate
from kora_quant.sim.service import reality_checks

# A healthy, modest edge: 45% winners at 1.8 R, costs 0.08 R, 1% risk, full Kelly ≈ 9.7%.
CLEAN = CheckInput(
    win_rate=0.45,
    avg_win_r=1.8,
    expectancy_after_costs_r=0.18,
    risk_fraction=0.01,
    full_kelly=0.097,
    imported_trades=250,
    source="backtest_out_of_sample",
)

FIRING: dict[str, CheckInput] = {
    "implausible_edge": replace(CLEAN, win_rate=0.60, avg_win_r=2.0),
    "no_edge_after_costs": replace(CLEAN, expectancy_after_costs_r=0.0),
    "above_full_kelly": replace(CLEAN, risk_fraction=0.12),
    "risk_above_2pct": replace(CLEAN, risk_fraction=0.025),
    "small_sample": replace(CLEAN, imported_trades=99),
    "in_sample_source": replace(CLEAN, source="backtest_in_sample"),
}

NOT_FIRING: dict[str, CheckInput] = {
    "implausible_edge": replace(CLEAN, win_rate=0.59, avg_win_r=3.0),
    "no_edge_after_costs": replace(CLEAN, expectancy_after_costs_r=0.001),
    "above_full_kelly": replace(CLEAN, risk_fraction=0.02),
    "risk_above_2pct": replace(CLEAN, risk_fraction=0.02),
    "small_sample": replace(CLEAN, imported_trades=100),
    "in_sample_source": replace(CLEAN, source="paper"),
}


def codes(x: CheckInput) -> set[str]:
    return {c.code for c in evaluate(x)}


def test_clean_fixture_fires_nothing() -> None:
    assert evaluate(CLEAN) == []


@pytest.mark.parametrize("code", sorted(FIRING))
def test_rule_fires(code: str) -> None:
    assert code in codes(FIRING[code])


@pytest.mark.parametrize("code", sorted(NOT_FIRING))
def test_rule_does_not_fire(code: str) -> None:
    assert code not in codes(NOT_FIRING[code])


def test_every_rule_is_documented() -> None:
    from pathlib import Path

    doc = (Path(__file__).resolve().parents[3] / "docs/quant/reality-checks.md").read_text()
    for code in FIRING:
        assert f"`{code}`" in doc


def test_risk_severity_escalates_above_5pct_and_ordering() -> None:
    checks = evaluate(replace(CLEAN, risk_fraction=0.06, imported_trades=10))
    by_code = {c.code: c for c in checks}
    assert by_code["risk_above_2pct"].severity == "critical"
    assert evaluate(FIRING["risk_above_2pct"])[0].severity == "warning"
    severities = [c.severity for c in checks]
    assert severities == sorted(severities, key=["critical", "warning", "info"].index)


def test_not_applicable_inputs_are_skipped() -> None:
    x = replace(CLEAN, risk_fraction=None, imported_trades=None, source=None)
    assert evaluate(x) == []
    no_edge = replace(CLEAN, full_kelly=0.0, risk_fraction=0.5, expectancy_after_costs_r=-0.1)
    assert "above_full_kelly" not in codes(no_edge)


def test_reality_check_endpoint_logic() -> None:
    res = reality_checks(
        RealityCheckRequest(
            win_rate_pct=65,
            avg_win_r=2.5,
            risk_pct=3,
            imported_trades=40,
            source="backtest_in_sample",
        )
    )
    # full Kelly here is 0.65 - 0.35/2.5 = 51%, so 3% is not above it
    assert {c.code for c in res.checks} == {
        "implausible_edge",
        "risk_above_2pct",
        "small_sample",
        "in_sample_source",
    }
    res2 = reality_checks(RealityCheckRequest(win_rate_pct=40, avg_win_r=1.4, cost_per_trade_r=0.2))
    assert [c.code for c in res2.checks] == ["no_edge_after_costs"]
