# Architecture decision records

Numbering:
- `0000`–`0010` match the goal numbers. For example, goal 02 writes `0002-market-data.md`, goal 03 writes `0003-oms.md` and goal 07 writes `0007-ai-copilot.md`.
- `01xx` are supplementary decisions made during goal 01. `02xx` are for goal 02, and so on.

| ADR | Title | Status |
|---|---|---|
| [0000](0000-dev-environment.md) | Development and test environment | Accepted |
| [0001](0001-stack.md) | Technology stack | Accepted |
| [0002](0002-market-data.md) | Market data layer: global registry, sessions, adapters, simulator, storage, gateway | Accepted |
| [0003](0003-oms.md) | OMS, paper engine, pre-trade risk, kill switch, reconciliation, appropriateness | Accepted |
| [0101](0101-dev-identity-provider.md) | Identity: OIDC abstraction, dev IdP, TOTP MFA | Accepted |
| [0102](0102-audit-hash-chain.md) | Append-only hash-chained audit log | Accepted |
| [0005](0005-gain-simulator.md) | Gain simulator: engine, determinism, numbers, service boundary | Accepted |
| [0004](0004-pro-terminal.md) | Pro terminal: docking, hot path, indicators, ticket, alerts, risk tab, test aids | Accepted |
| [0006](0006-robot-trader.md) | Robot trader: DSL, single evaluator, backtester, bot runner ↔ OMS, promotion | Accepted |
| [0007](0007-ai-copilot.md) | AI copilot: gateway, read-only/draft tools, calibration table, safety, evals, threat model | Accepted |
| [0007B](0007b-market-intelligence.md) | Market intelligence: scanner, regime filter, calibrated trend forecasts, news pipeline, Market Radar, threat model additions | Accepted |
| [0008](0008-novice-view.md) | Novice view: server-side guardrails, server-built ticket, disclosures interface, i18n, PWA | Accepted |
| [0009](0009-governance.md) | Risk, compliance and governance: control catalogue and evidence, three lines (auditor role), four-eyes engine, firm halts, live risk alerts, internal audit and anchors, disclosures registry, compliance hooks | Accepted |
