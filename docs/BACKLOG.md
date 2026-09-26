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
| B-018 | Remove self-service `trader` at sign-up (OQ-S2 decision). Sign-up creates `novice` only; `POST /appropriateness` assessment (versioned questions, pass mark, cool-down on fail, audit event) upgrades the role to `trader` and requires TOTP enrolment on the next login. API tests and e2e required. | Sponsor decision | 03 (gate), 08/09 (questionnaire engine) | Open |
| B-201 | TimescaleDB: hypertables for `md_trades`/`md_bars_1s`, continuous aggregates replacing `md_refresh_candles`, compression and retention policies; exercise the guarded DDL in a Timescale CI job | ADR 0002 | 10 | Open |
| B-202 | Minor-unit quotes (GBX, ZAc) and price multipliers in the registry; LSE/JSE instruments currently quoted in major units | G2 | 04 | Open |
| B-203 | WebSocket: per-user and per-IP connection quotas, token refresh over an open socket (today the socket closes at token expiry) | G2 S9 review | 09 | Open |
| B-204 | Licensed reference data: authoritative venue calendars and holidays, tick-size tables by price band (TSE, HKEX, Xetra), FIGIs, corporate actions (OQ-M2) | G2 | 09 | Open |
| B-205 | Real provider transports behind the stub decoders (after OQ-B1/B2), secrets from vault, recorded fixtures replacing hand-crafted ones | G2 | post-RC | Open |
| B-206 | Simulator CPU: Decimal-heavy step (~0.3 ms per instrument step under coverage); integer tick maths if one feed process must simulate > 200 symbols | G2 | 10 | Open |
| B-207 | Gateway scale-out: load-test 2+ api replicas behind a load balancer (Redis fans out to each) and run the committed k6 scenario in CI | G2 | 10 | Open |
| B-208 | Session-aware UX: "market closed" badge from `session` (not "stale"), and `KORA_MD_RESPECT_SESSIONS=true` as the default outside dev | G2 | 04 | Open |
| B-209 | OpenAPI response schemas for the market data endpoints, then SDK generation (B-004) | G2 | 03 | Open |
| B-210 | `trades:{symbol}` WebSocket channel (time and sales) and the chart / order book / calendar panels | G2 | 04 | Open |
| B-501 | Replace the SIMULATED paper fixture in `apps/api/src/sim/paper-fixture.ts` with the account's real paper fills from the goal 03 engine (same `Fill[]` contract into `/analytics/paper`); add contract multipliers from the instrument registry | goal 05 | 03 | Open |
| B-502 | "Import from backtest" / Robots "Send to Monte Carlo": post the goal 06 trade list (R multiples, `source` IS/OOS) to `/sim/from-trades`; enable the button | goal 05 | 06 | Open |
| B-503 | Shared simulation result cache (Redis, keyed by the same input hash) if the quant service scales beyond one process | ADR 0005 | 10 | Open |
| B-504 | Human plain-language review of the Novice Practice copy (S1 + S8), including FR once B-013 lands; the automated jargon scan is in place | goal 05 | 08 | Open |
| B-505 | Save and name scenarios per user (A/B compare is in-session only today) | goal 05 | 08 | Open |
| B-506 | Regenerate `packages/sdk/openapi.json` after merging goals 02 and 05, and add typed `/sim/*` methods to the SDK (the web uses `apps/web/src/lib/sim/client.ts` meanwhile) | goal 05 | 03 | Open |
| B-507 | OpenTelemetry spans in the quant service (FastAPI instrumentation, trace context from the api); today it has structured logs with the input hash only | goal 05 | 10 | Open |
