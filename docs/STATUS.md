# KORA — delivery status

Last updated: 2026-09-26 (end of goal 01).

| Gate | Goal | State |
|---|---|---|
| G0 | 00 master plan | **Done**: `docs/plans/00-master.md`, ADR 0000/0001, charter |
| G1 | 01 foundation | **Done, with deferrals**: see `docs/plans/01-foundation.md` §4 and §6 |
| G2 | 02 market data | Next |

## What shipped in goal 01

- **Monorepo:**
  - pnpm + Turborepo;
  - shared TS/ESLint/Prettier configs (`packages/config`);
  - ruff and mypy configs in `services/quant/pyproject.toml`.
- **Native dev services:** `scripts/dev-db.sh` (Postgres :55432, Redis :56379, `.data/`). `pnpm dev` works without Docker.
- **API (`apps/api`):**
  - dev OIDC IdP (sign-up, scrypt, TOTP enrolment and verification, ES256 JWT + JWKS);
  - global auth guard (CSRF, MFA rule, `@Roles`);
  - `user_preferences`;
  - `POST /kill-switch` (audited intent);
  - `GET /audit`, `GET /audit/verify`;
  - `/health` (db, redis, keycloak);
  - OpenAPI at `/docs`.
- **Audit:** append-only, hash-chained `audit_events`. Insert-only runtime role, owner-level immutability trigger, tamper detection with the first broken id.
- **Design system (`packages/ui`):**
  - pro-dark and novice-light tokens;
  - 16 primitives, including `HoldToConfirmButton`, decimal-safe `NumberInput`, `DirectionBadge`, and `Money`/`Price`;
  - Storybook with the a11y addon;
  - axe on every story (jsdom and Chromium);
  - contrast check (106 pairs).
- **Web (`apps/web`):**
  - login, sign-up and QR TOTP enrolment;
  - middleware session and role guards (friendly 403) with a CSP nonce;
  - Pro shell (top bar, left rail, status bar) and Novice shell (tabs, risk banner, mobile bottom bar);
  - Pro ⇄ Novice toggle, persisted and instrument-preserving, with a "what changed" note;
  - kill switch (1.5 s hold by mouse, touch, Space or Ctrl+Shift+K → three scopes → audit event);
  - audit viewer with chain verification; settings.
- **Services:** quant (FastAPI `/health`) and bot-runner (BullMQ heartbeat worker, `/health`).
- **Infra:** compose reference (Timescale, Redis, Keycloak, OTel, Prometheus, Grafana), Keycloak realm with conditional OTP, Dockerfiles, and the GitHub Actions CI.

## Stubbed or placeholder (explicit in the UI)

- Account summary values, watchlist, chart, order preview numbers and blotter are shown as "—" or as "arrives in goal NN".
- The kill switch records intent only (`engine: not_wired_goal_03`).
- The robot builder, simulator, practice, auto-invest and learn pages are placeholders.
- The command palette is an entry point only.

## Deferred (reasons in plan 01 §6)

- The Keycloak and compose runtime path (B-001).
- The Trivy and image builds (B-008).
- A GitHub Actions run (cannot push from this session).

## What goal 02/03 needs to know

- **Start the DB:** `bash scripts/dev-db.sh start`, or just `pnpm dev`. Migrate with `pnpm db:migrate`; add `-- --all` to also migrate `kora_test`.
- **Add migrations:** as `apps/api/migrations/NNNN_name.sql`. They are forward-only and checksummed. Each one must `GRANT` explicitly to `kora_app` (and `kora_audit_reader` for read-only). Timescale: `create_hypertable` only inside `IF EXISTS (select from pg_extension where extname='timescaledb')`.
- **Audit:** inject `AuditService` and call `record({actorId, actorType, action, entity, entityId, payload}, client?)`.
  - Pass the transaction `client` so the audit row commits atomically with the business change. The transaction must be READ COMMITTED.
  - Payload numbers must be safe integers. Send decimals as strings.
  - Action names look like `kill_switch.requested`, matching the regex `^[a-z0-9_]+(\.[a-z0-9_]+)*$`.
- **Auth in the API:** every route is authenticated by default. Use `@Public()` to opt out and `@Roles(...)` to restrict. Non-novice roles always need `amr: otp`. `@CurrentPrincipal()` gives `{sub, roles, mfa}`.
- **Auth in tests:** use the real flow (`apps/api/test/helpers.ts`):
  - `createUser(app, 'novice' | 'trader', extraRoles?)` signs up, logs in and does TOTP enrolment/verify, then returns a bearer token.
  - `nextTotpWindow()` advances the faked `Date` 31 s, so repeated logins don't hit TOTP replay protection.
  - Extra roles are granted with a direct owner SQL insert.
  - Send `x-kora-csrf: 1` on unsafe requests unless you use `Authorization: Bearer`.
  - e2e uses `apiSignIn(page, type)` in `apps/web/e2e/helpers.ts`.
- **Decimals:** `import { dec, quantize, roundToTick, Decimal } from '@kora/domain'`. `dec(0.1)` throws by design. The UI formats via `formatPrice(value, precision)` and `formatMoney` from `@kora/ui`.
- **Kill switch:** the web calls `POST /kill-switch {scope, source}` with scopes `robots | robots_cancel | robots_cancel_flatten`. Goal 03 replaces the intent-only handler with the engine and audits each child action.
- **Order types:** the server capability is `GET /me → capabilities.orderTypes` (novice view = `['market']`). The goal 03 OMS must enforce role guardrails server-side (goal 08).
- **Ports:**
  - dev: web 3000, api 4000, quant 8000, bot-runner 4100;
  - e2e: api 4010, web 3010, db `kora_e2e`;
  - integration tests: db `kora_test`.
- **Env:** everything lives in the repo-root `.env`. The api and web load it themselves and never override variables that are already set.
