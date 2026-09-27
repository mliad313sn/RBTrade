# Test pyramid and coverage — RC-1 (goal 10)

Measured 2026-09-27 with `pnpm test` (v8 coverage in every TypeScript workspace, pytest-cov in
quant). Every gate below fails the build when coverage drops under its threshold.

| Package | Scope measured | Lines | Branches | Functions | Gate |
|---|---|---|---|---|---|
| `packages/domain` | all source | 99.4 % | 95.2 % | 99.5 % | 85/85/85 |
| `packages/market-data` | all source | 99.3 % | 92.2 % | 97.1 % | 85/85/85 |
| `packages/ui` | components and tokens | 99.5 % | 92.2 % | 98.2 % | 85/80/80 |
| `packages/sdk` | client (generated types excluded) | 97.0 % | 89.2 % | 91.0 % | lines 85 |
| `apps/api` (unit) | pure cores: auth crypto, config, AI and intel cores, governance export and controls, disclosures | 98.4 % | 90.4 % | 96.9 % | 85/80/85 |
| `apps/web` (unit, **new gate**) | pure logic: formatting, layout, route rules, novice and simulator helpers, market store | 94.7 % | 85.0 % | 87.2 % | 85/80/80 |
| `services/bot-runner` | runner, bots, jobs, config | 96.5 % | 78.7 % | 100 % | lines 80 |
| `services/quant` | whole package | 97 % | — | — | 85 |

Domain logic is therefore ≥ 85 % everywhere. Stateful service code (Nest controllers and services,
repositories, the WS gateway, web HTTP clients and stores) is covered by the layers above unit tests
rather than by line coverage:

- **Integration** (`apps/api/test/*.int.test.ts`, real Postgres + Redis): 47 suites, including the
  authz matrix (every route × 7 roles), security hardening, tracing, chaos-relevant feed resilience.
- **Contracts:** `contracts.int.test.ts` validates live responses of every documented endpoint
  against the OpenAPI document (ajv); `quant-contract.int.test.ts` checks the api's quant payloads
  against quant's own OpenAPI; `contract-proxy.ts` checks the bot runner's `/internal/*` calls;
  the SDK's types are generated from OpenAPI (`packages/sdk/src/generated/openapi.ts`) and a
  type-level test fails on drift.
- **e2e** (`apps/web/e2e`, Playwright on the native stack): golden paths for all seven goal 10
  flows, axe on every route, keyboard walkthrough, screen-reader spot checks, security headers.
- **AI evals** (`pnpm evals`, scripted provider, thresholds enforced).

Gaps kept on purpose: branch coverage of the bot runner (78.7 %) sits under 80 % in error paths
that the integration and chaos tests exercise with real Redis/quant failures; not a domain-logic gap.
