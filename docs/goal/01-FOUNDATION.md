# /goal 01 — Foundation: monorepo, identity, design system, app shell, audit log

**Load first:** `docs/goal/00-master.md`, `/design/prototype/Committee.dc.html` (tokens), `Main.dc.html` (shell).

## Goal
Create the KORA monorepo skeleton and the cross-cutting foundations that every other module plugs into: identity and roles, the design system with two themes, the app shell with the Pro ⇄ Novice switch, the environment chip (PAPER/LIVE), the kill-switch entry point (UI only for now) and the append-only audit log service.

## Scope
1. **Monorepo:** pnpm workspaces and Turborepo matching the master layout.
   - Shared `tsconfig`, ESLint, Prettier, ruff and mypy configs.
   - `docker-compose.yml` with Postgres 16 + TimescaleDB, Redis 7, Keycloak, OTel collector, Prometheus and Grafana.
   - `.env.example` with every variable documented.
2. **Identity:** Keycloak realm export in `infra/keycloak/`.
   - OIDC login in web and api, TOTP MFA required for the `trader`, `quant`, `risk_officer` and `admin` roles.
   - RBAC guard decorators in NestJS and route guards in Next.js.
   - A `user_preferences` table: `view_mode` (pro|novice), theme, colour convention (`blue_orange` default | `green_red` | `red_up_asia`) and hotkeys.
3. **Design system (`packages/ui`):**
   - Tokens as CSS variables:
     - pro-dark: bg `#0B0E13`, panel `#11151C`, raised `#1A202A`, border `#262E3B`, text `#E6EAF0`/`#9AA4B2`, up `#4DA3FF`, down `#FF9F40`, ai `#A78BFA`, warn `#F2C94C`, kill `#FF4D6D`;
     - novice-light: paper `#F7F5F0`, card `#FFFFFF`, text `#1C2430`, up `#1D6FD1`, down `#B8520B`, accent `#3E5BD8`.
   - Fonts: IBM Plex Mono (numbers, tabular, slashed zero) and IBM Plex Sans Condensed for Pro; Figtree and Fraunces for Novice.
   - Primitives: Button, IconButton, Input, NumberInput (decimal-safe), Select, Tabs, Panel, Table (virtualised), Chip, Dialog, HoldToConfirmButton (configurable ms, progress fill, keyboard accessible), Toast, Banner (info/warn/critical), Kbd, DirectionBadge (▲▼ + sign + colour), Money and Price formatters driven by instrument precision.
   - A Storybook with a11y addon for every primitive.
4. **App shell (`apps/web`):**
   - Top bar: logo, ⌘K command palette, env chip, account summary slot, Pro/Novice segmented control, kill-switch button, avatar.
   - Left rail with modules Terminal / Simulator / Robots / Portfolio / Settings.
   - Status bar showing connection, latency, feed status, UTC clock and env.
   - Novice layout: top tabs Home / Practice / Auto-invest / Learn, plus a mobile bottom tab bar.
   - Switching mode keeps the same account and instrument and shows a one-line "what changed" note.
5. **Audit log service (`apps/api/audit`):**
   - An `audit_events` table: id, ts (UTC, µs), actor_id, actor_type (user|robot|ai|system), action, entity, entity_id, payload JSONB, prev_hash, hash (SHA-256 over the canonical JSON + prev_hash).
   - Insert-only DB role; UPDATE and DELETE revoked at role level.
   - `AuditService.record()` is used by every later module.
   - `GET /audit` (filter by actor, entity, action, time) and `GET /audit/verify`, which recomputes the chain.
6. **CI:** GitHub Actions for lint, typecheck, unit tests, Python tests, build, Playwright smoke, and Trivy image scan plus dependency audit.

## Out of scope
Market data, orders and charts (later goals). The kill switch only opens its scoped menu and records an audit event here; goal 03 wires it to the engine.

## Acceptance criteria
- [ ] `docker compose up -d && pnpm dev` starts everything. `/health` on api returns the status of db, redis and keycloak.
- [ ] Sign-up → MFA enrolment → login works. A `novice` user cannot reach the `/robots/*` builder routes (403 plus a friendly page).
- [ ] The Pro/Novice toggle persists per user and survives reload. Novice hides advanced order types (verified by an e2e test).
- [ ] The kill-switch button needs a 1.5 s hold (mouse, touch and keyboard Space-hold) and opens the three-scope menu. Choosing a scope writes an audit event.
- [ ] `GET /audit/verify` returns `valid:true`. A manual tamper of one row in a test DB makes it return `valid:false` with the first broken id.
- [ ] Every primitive has a Storybook story with no axe violations. Text contrast is ≥ 4.5:1 in both themes (automated check).
- [ ] CI is green. `docs/adr/0001-stack.md` and `docs/STATUS.md` are written.
