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
| B-014 | Sign-up returns 409 for an existing email (account enumeration). Move to a verify-email flow with a generic response. | G1 S9 review | 09 | Open |
| B-015 | Deployment edge proxy must set a trusted `X-Forwarded-For`. The web `/api` proxy forwards only the nearest hop. | G1 S9 review | 10 | Open |
| B-016 | Instrument registry (goal 02) must feed `Price`/`NumberInput` precision. The goal 01 UI uses explicit precisions only in stories and the ticket skeleton. | G1 | 02 | Open |
| B-017 | The optional TOTP opt-in for novice accounts (API supports MFA for any user once enrolled) needs a settings UI | G1 | 08 | Open |
| B-018 | Replace the SIMULATED paper fixture in `apps/api/src/sim/paper-fixture.ts` with the account's real paper fills from the goal 03 engine (same `Fill[]` contract into `/analytics/paper`); add contract multipliers from the instrument registry | goal 05 | 03 | Open |
| B-019 | "Import from backtest" / Robots "Send to Monte Carlo": post the goal 06 trade list (R multiples, `source` IS/OOS) to `/sim/from-trades`; enable the button | goal 05 | 06 | Open |
| B-020 | Shared simulation result cache (Redis, keyed by the same input hash) if the quant service scales beyond one process | ADR 0005 | 10 | Open |
| B-021 | Human plain-language review of the Novice Practice copy (S1 + S8), including FR once B-013 lands; the automated jargon scan is in place | goal 05 | 08 | Open |
| B-022 | Save and name scenarios per user (A/B compare is in-session only today) | goal 05 | 08 | Open |
| B-023 | Regenerate `packages/sdk/openapi.json` after merging goals 02 and 05, and add typed `/sim/*` methods to the SDK (the web uses `apps/web/src/lib/sim/client.ts` meanwhile) | goal 05 | 03 | Open |
| B-024 | OpenTelemetry spans in the quant service (FastAPI instrumentation, trace context from the api); today it has structured logs with the input hash only | goal 05 | 10 | Open |
