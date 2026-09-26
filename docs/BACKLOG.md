# Backlog

Ordered by the Product Owner. Anything found at a gate lands here and is scheduled before goal 10.

| ID | Item | Source | Target goal | Status |
|---|---|---|---|---|
| B-001 | Keycloak end-to-end in CI (compose up, realm import, conditional OTP by role, BFF code flow `/auth/oidc/*`) | G1 deferred | 10 | Open |
| B-002 | Refresh tokens and server-side session revocation (logout everywhere) | ADR 0101 | 09 | Open |
| B-003 | MFA recovery codes and a TOTP reset flow with four-eyes | ADR 0101 / OQ-S1 | 09 | Open |
| B-004 | Generate `packages/sdk` from OpenAPI (`openapi-typescript`), contract tests | ADR 0001 | 03 | Open |
| B-005 | WebSocket gateway, plus kill switch REST fallback wired to the engine | goal 01 scope | 02/03 | Open |
| B-006 | Audit chain throughput: per-partition chains + global checkpoints if kill switch load shows contention | ADR 0102 | 03 | Open |
| B-007 | Anchor the audit head hash externally (WORM / signed daily digest) | ADR 0102 | 09 | Open |
| B-008 | Trivy image scan and container hardening verified in CI (no Docker locally) | G1 deferred | 10 | Open |
| B-009 | Command palette (⌘K) actions; goal 01 ships the shell entry point only | goal 01 | 04 | Open |
| B-010 | Toolchain major upgrades (TS 7, Next 16, Nest 12, vitest 5, ESLint 10, Storybook 10) | ADR 0001 | 10 | Open |
| B-011 | Visual regression vs prototype at 1440×900 | goal 04 | 04 | Open |
| B-012 | Grafana dashboards beyond provisioning stub; alert → runbook links | goal 01 infra | 10 | Open |
| B-013 | FR translations (EN only in goal 01) | goal 08 | 08 | Open |
