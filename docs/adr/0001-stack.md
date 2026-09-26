# ADR 0001 — Technology stack

- Status: Accepted (2026-09-26)
- Deciders: Project Owner, S3 (architect), S1 (designer), S9 (security)
- Supersedes: nothing. Amends the master goal's reference architecture where noted under "Deviations".

## Decision: the master stack is confirmed

| Layer | Choice | Pinned major |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | pnpm 10, turbo 2 |
| Language | TypeScript `strict` (+ `noUncheckedIndexedAccess`) | 5.9 |
| Web | Next.js App Router, React, Tailwind v4 over CSS-variable tokens, TanStack Query, Zustand | Next 15.5, React 19.2 |
| Charts | lightweight-charts (from goal 04) | — |
| API | NestJS, zod v4 DTOs (custom `ZodValidationPipe`), OpenAPI via `@nestjs/swagger` fed by `z.toJSONSchema` | Nest 11, zod 4 |
| Worker | BullMQ on Redis | bullmq 5 |
| Quant | Python FastAPI, pydantic v2; numpy/pandas/numba added in goal 05 | Python ≥ 3.11 |
| Database | PostgreSQL 16 (+ TimescaleDB where available) | 16 |
| Cache/queue | Redis 7 | 7 |
| Identity | OIDC (Keycloak in deployment), TOTP MFA, RBAC | Keycloak 26 |
| Decimals | `decimal.js` (TS), `numeric` (SQL), `decimal.Decimal` (Python) | 10 |
| Design system | `packages/ui`: plain CSS with CSS variables + React primitives, Radix for Dialog/Tabs, TanStack Virtual for Table, Storybook + a11y addon | Storybook 9 |
| Fonts | IBM Plex Mono, IBM Plex Sans Condensed, Figtree, Fraunces, self-hosted via `@fontsource` (no runtime Google Fonts request) | — |
| Tests | vitest (TS unit + api integration against real Postgres), Playwright (e2e), pytest | vitest 3, PW 1.56 |
| Lint | ESLint 9 flat config + typescript-eslint, Prettier; ruff + mypy `--strict` | — |
| Logs/traces | pino (nestjs-pino) JSON logs; OpenTelemetry SDK, OTLP exporter enabled by env | — |
| AI | Anthropic SDK; model from `KORA_AI_MODEL` (goal 07) | — |

**Pinned majors.** The newest majors at the time of writing (for example TypeScript 7, Next 16, Nest 12, vitest 5, ESLint 10) were released very recently. We pin the previous stable majors listed above. Upgrades are tracked in `docs/BACKLOG.md` (B-010).

## Data access and migrations

- **Access:** `pg` (node-postgres) with parameterised SQL in small repository classes. There is no ORM. Numeric columns come back as strings and are wrapped in `Decimal`.
- **Migrations:** plain, forward-only SQL files in `apps/api/migrations/NNNN_name.sql`. A small runner (`apps/api/src/db/migrate.ts`) applies them in order inside a transaction and records `(version, name, sha256)` in `schema_migrations`. If an applied file's checksum changes, the runner fails. Reasons:
  - DDL such as `REVOKE` and `CREATE ROLE`, triggers and the Timescale guards are clearer as raw SQL than in any ORM DSL;
  - no generator or runtime dependency;
  - identical behaviour in CI, native dev and compose.
- **Roles:** created by `scripts/db-bootstrap.sh` / `infra/postgres/init` (cluster-level), with passwords from env.
  - `kora_owner` owns the schema and runs migrations.
  - `kora_app` is used by the API at runtime. On `audit_events` it has `SELECT, INSERT` only; `UPDATE, DELETE, TRUNCATE` are revoked.
  - `kora_audit_reader` is read-only, for auditors and goal 09.

## Deviations from the master goal (each needs a reason)

1. **Dev identity provider (S9).** Keycloak stays the deployment IdP: it is in compose, with a realm export in `infra/keycloak/`. We cannot run it in the build environment. So the api includes an **OIDC-compatible dev identity provider** (`AUTH_PROVIDER=dev`). It offers:
   - sign-up;
   - password login (scrypt);
   - TOTP enrolment and verification (RFC 6238, secrets AES-256-GCM encrypted at rest);
   - ES256 JWTs with Keycloak-shaped claims (`realm_access.roles`, `amr`);
   - a JWKS endpoint and discovery document.

   The API guard verifies every token against a JWKS (local or Keycloak) through one code path. `AUTH_PROVIDER=keycloak` switches the issuer. The dev IdP refuses to start when `NODE_ENV=production`. Details are in ADR 0101.
2. **TimescaleDB optional.** Tables are plain Postgres with the same schema. Goal 02 migrations call `create_hypertable` only `IF EXISTS (select from pg_extension where extname='timescaledb')`.
3. **Python 3.11 compatible** (ADR 0000). The target stays 3.12 in Docker images.
4. **Next.js 15.5 instead of the latest major** (see pinned majors). `middleware.ts` handles route guards and the CSP nonce.
5. **SDK hand-written for goal 01.** `packages/sdk` is a typed stub over `fetch`. OpenAPI generation (`openapi-typescript`) replaces it once the surface grows in goal 02/03 (BACKLOG B-004).
6. **Session transport.** The web app proxies `/api/*` to the api through a Next rewrite, so auth uses a same-origin `HttpOnly; SameSite=Strict` cookie (`kora_at`) instead of tokens in JS. Mutating requests additionally need the `x-kora-csrf: 1` header. Non-browser clients (SDK, tests) use `Authorization: Bearer`.

## Consequences

- One `Principal` abstraction lets goal 03+ use `@Roles()` / `@RequireMfa()` without caring which IdP issued the token.
- The Keycloak-specific flow (conditional OTP by role) is configured in the realm export but only exercised in CI with Docker (deferred, BACKLOG B-001).
