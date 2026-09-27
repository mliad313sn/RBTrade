# Test pyramid and coverage — RC-1 (goal 10)

Re-measured 2026-09-27 for the IRTC R6 corrections with `pnpm test` (v8 coverage in every TypeScript
workspace, pytest-cov in quant) and `pnpm --filter @kora/api test:integration` (v8 coverage over the
whole api source). Every gate below fails the build when coverage drops under its threshold.

| Package | Scope measured | Lines | Branches | Functions | Gate |
|---|---|---|---|---|---|
| `packages/domain` | all source | 99.4 % | 95.6 % | 99.6 % | 85/85/85 |
| `packages/market-data` | all source | 99.4 % | 92.2 % | 97.1 % | 85/85/85 |
| `packages/ui` | components and tokens | 99.7 % | 92.4 % | 98.6 % | 85/80/80 |
| `packages/sdk` | client (generated types excluded) | 97.0 % | 89.2 % | 91.0 % | lines 85 |
| `apps/api` (unit) | pure cores: auth crypto, config and env mode, AI and intel cores, the production Anthropic provider (mocked transport), governance export and controls, disclosures | 99.1 % | 92.1 % | 97.4 % | 85/80/85 |
| `apps/api` (integration, **new gate**, IRTC R6-06) | whole `src/**` (CLIs, `main.ts`, seeds excluded), real Postgres + Redis | 92.3 % | 82.7 % | 96.0 % | 90/80/94 global; trading 94/84, audit 93/82, governance 82/80, ai 86/75 (lines/branches) |
| `apps/web` (unit) | pure logic: formatting, layout, route rules, novice and simulator helpers, market store, live book | 95.0 % | 85.9 % | 87.1 % | 85/80/80 |
| `services/bot-runner` | runner, bots, jobs, config | 96.3 % | 79.2 % | 100 % | lines 80 |
| `services/quant` | whole package (186 tests) | 97.5 % | — | — | 85 |

Domain logic is therefore ≥ 85 % everywhere. Stateful service code (Nest controllers and services,
repositories, the WS gateway, web HTTP clients and stores) is covered by the layers above unit tests
rather than by line coverage:

- **Integration** (`apps/api/test/*.int.test.ts`, real Postgres + Redis): 50 files / 321 tests,
  including the authz matrix (every route × 7 roles), security hardening, tracing, chaos-relevant
  feed resilience, the whole-database "AI never executes" fingerprint and the IRTC regressions.
  Line coverage of the api from this layer is gated (row above).
- **Contracts:** `contracts.int.test.ts` validates live responses of every documented endpoint
  against the OpenAPI document (ajv); `quant-contract.int.test.ts` checks the api's quant payloads
  against quant's own OpenAPI; `contract-proxy.ts` checks the bot runner's `/internal/*` calls;
  the SDK's types are generated from OpenAPI (`packages/sdk/src/generated/openapi.ts`) and a
  type-level test fails on drift.
- **e2e** (`apps/web/e2e`, Playwright on the native stack): golden paths for all seven goal 10
  flows, axe on every route, keyboard walkthrough, screen-reader spot checks, security headers.
- **AI evals** (`pnpm evals`, scripted-provider regression: it proves the pipeline, guards and
  graders, not model quality; the live eval is the secrets-gated CI job `ai-evals-live`).
- **Mutation testing** (IRTC R6, manual, 41 mutants on safety-critical code plus 3 extra): all killed;
  see `docs/review/IRTC-R6-fixes.md`.

Gaps kept on purpose: branch coverage of the bot runner (79.2 %) sits under 80 % in error paths
that the integration and chaos tests exercise with real Redis/quant failures; not a domain-logic gap.
