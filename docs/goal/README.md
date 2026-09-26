# KORA goal prompt pack — how to use

This pack contains 11 prompts: one master goal plus 10 module goals. They take the KORA prototype canvas to a full platform with Claude (Claude Code / Cowork).

## Setup (once)
1. Create an empty git repo `kora/`.
2. Copy this folder to `kora/docs/goal/`.
3. Export the prototype canvas artboards into `kora/design/prototype/`.
4. Create `kora/CLAUDE.md` containing one line: `Always read docs/goal/00-MASTER-GOAL.md before any work.`

## Run order
Use one session per goal, in order. Review and commit before starting the next.

```
/goal Execute docs/goal/00-MASTER-GOAL.md: set up the plan files and confirm the stack (no code yet)
/goal Execute docs/goal/01-FOUNDATION.md until every acceptance criterion passes
/goal Execute docs/goal/02-MARKET-DATA.md until every acceptance criterion passes
/goal Execute docs/goal/03-OMS-PAPER-ENGINE-RISK.md ...
/goal Execute docs/goal/04-PRO-TERMINAL-UI.md ...
/goal Execute docs/goal/05-GAIN-SIMULATOR.md ...
/goal Execute docs/goal/06-ROBOT-TRADER.md ...
/goal Execute docs/goal/07-AI-COPILOT.md ...
/goal Execute docs/goal/08-NOVICE-VIEW.md ...
/goal Execute docs/goal/09-RISK-COMPLIANCE-GOVERNANCE.md ...
/goal Execute docs/goal/10-QA-SECURITY-OBSERVABILITY-RELEASE.md ...
```

Goals 05 and 08 can run in parallel worktrees once 03 is done.

## Review gate after each goal
- Read `docs/plans/<module>.md`, the test output and `docs/STATUS.md`.
- Tick the acceptance criteria yourself.
- Log any new regulatory or broker questions in `docs/open-questions.md`.

## Important
Live trading with real money is disabled by design (`LIVE_TRADING_ENABLED=false`). Turning it on requires:
- a licensed broker partner;
- legal and compliance sign-off for each target jurisdiction;
- the goal 09 controls operating.
