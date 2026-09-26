"""Robot Trader research engine (goal 06): DSL, bar backtester, metrics, overfitting controls.

The same evaluator serves backtests and the bot runner's live signals (`/bt/signal`), so the
paper run and the backtest can only differ in fills, never in logic.
"""
