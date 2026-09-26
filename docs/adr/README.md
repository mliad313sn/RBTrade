# Architecture decision records

Numbering:
- `0000`–`0010` match the goal numbers. For example, goal 02 writes `0002-market-data.md`, goal 03 writes `0003-oms.md` and goal 07 writes `0007-ai-copilot.md`.
- `01xx` are supplementary decisions made during goal 01. `02xx` are for goal 02, and so on.

| ADR | Title | Status |
|---|---|---|
| [0000](0000-dev-environment.md) | Development and test environment | Accepted |
| [0001](0001-stack.md) | Technology stack | Accepted |
| [0002](0002-market-data.md) | Market data layer: global registry, sessions, adapters, simulator, storage, gateway | Accepted |
| [0101](0101-dev-identity-provider.md) | Identity: OIDC abstraction, dev IdP, TOTP MFA | Accepted |
| [0102](0102-audit-hash-chain.md) | Append-only hash-chained audit log | Accepted |
| [0005](0005-gain-simulator.md) | Gain simulator: engine, determinism, numbers, service boundary | Accepted |
