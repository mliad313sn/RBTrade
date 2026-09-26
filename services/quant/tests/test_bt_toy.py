"""Acceptance: a known toy strategy on a fixed synthetic series matches hand-computed trades
exactly.

Strategy: long when close > highest high of the previous 3 bars; stop 5 % and target 4 % of the
decision close away from the entry reference (the ask at the fill); time stop after 3 bars; fixed
size 1. Costs: tick 0.01, spread 2 ticks (half spread 0.01), commission 0.50 per unit with a 1.00
minimum, no volatility term, no funding.

Hand computation (decide on close t, fill at open t+1):
1. Close 3 = 102.50 > max(h0..h2) = 101 → buy at open 4: ask 102.61. Stop 102.61 − 5.125 → 97.48,
   target 102.61 + 4.10 = 106.71. Bar 5 high 107.00 (bid 106.99) reaches the target → sell 106.71.
   Net 4.10 − 2.00 = 2.10; risk 5.13 → R 0.409357.
2. Close 5 = 106.00 > max(h2..h4) = 104 → buy at open 6: ask 106.21, stop 100.91, target 110.45.
   Held 3 bars at close 8 → time stop → sell at open 9: bid 103.39. Net −2.82 − 2.00 = −4.82;
   risk 5.30 → R −0.909434.
3. Close 11 = 107.00 > max(h8..h10) = 104.5 → buy at open 12: ask 107.01, stop 101.66, target
   111.29. Bar 12 touches both (low 101, high 112): the conservative policy takes the stop → 101.66.
   Net −5.35 − 2.00 = −7.35; risk 5.35 → R −1.373832.
4. Close 12 = 108.00 > max(h9..h11) = 107.1 → buy at open 13: ask 108.51, stop 103.11. Data ends:
   closed at the last close's bid 108.49 (end_of_data). Net −0.02 − 2.00 = −2.02; risk 5.40 →
   R −0.374074.
Final equity 100,000 + 2.10 − 4.82 − 7.35 − 2.02 = 99,987.91.
"""

from __future__ import annotations

from bt_helpers import HOUR_MS, T0, toy_request
from kora_quant.bt.models import BacktestRunRequest
from kora_quant.bt.research import backtest

EXPECTED = [
    ("102.61", "106.71", "target", "97.48", "106.71", 2.10, 0.409357, 4, 5, 1),
    ("106.21", "103.39", "time_stop", "100.91", "110.45", -4.82, -0.909434, 6, 9, 3),
    ("107.01", "101.66", "stop", "101.66", "111.29", -7.35, -1.373832, 12, 12, 0),
    ("108.51", "108.49", "end_of_data", "103.11", "112.83", -2.02, -0.374074, 13, 14, 1),
]


def test_toy_strategy_matches_hand_computed_trades_exactly() -> None:
    out = backtest(BacktestRunRequest.model_validate(toy_request()))
    trades = out["trades"]
    assert len(trades) == len(EXPECTED)
    for t, (entry, exit_, reason, stop, target, net, r, i_in, i_out, held) in zip(
        trades, EXPECTED, strict=True
    ):
        assert t["side"] == "long"
        assert t["qty"] == "1"
        assert t["entryPrice"] == entry
        assert t["exitPrice"] == exit_
        assert t["reason"] == reason
        assert t["stopInitial"] == stop
        assert t["target"] == target
        assert t["commission"] == 2.0
        assert round(t["netPnl"], 2) == net
        assert round(t["rMultiple"], 6) == r
        assert t["entryTs"] == T0 + i_in * HOUR_MS
        assert t["exitTs"] == T0 + i_out * HOUR_MS
        assert t["barsHeld"] == held
        assert t["entrySignal"]["conditions"][0]["result"] is True
    assert out["equity"]["equity"][-1] == 99_987.91
    assert out["guard"] == {"checkpoints": 8, "passed": True, "enabled": True}


def test_entry_signal_records_features_and_contributions() -> None:
    out = backtest(BacktestRunRequest.model_validate(toy_request()))
    sig = out["trades"][0]["entrySignal"]
    assert sig["barTs"] == T0 + 3 * HOUR_MS
    cond = sig["conditions"][0]
    assert cond["label"] == "Close > Highest high 3"
    assert cond["values"] == {"Close": 102.5, "Highest high 3": 101.0}
    assert cond["contribution"] is not None and 0 < cond["contribution"] <= 1
