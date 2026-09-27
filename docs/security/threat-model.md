# KORA threat model (STRIDE) — RC-1

Owner: S9 (security engineer). Reviewers: S3 (architecture), S8 (risk), S10 (QA). Status: committed
for RC-1 on 2026-09-27 (goal 10). Re-review: at every change to auth, the order path, AI tools or
deployment topology, and before market launch (Sponsor gate).

Scope: the PAPER platform as built — `apps/web` (Next.js), `apps/api` (NestJS REST + WebSocket),
`services/quant` (FastAPI), `services/bot-runner` (BullMQ worker), Postgres, Redis, the dev IdP
(ADR 0101) or Keycloak (B-001), the AI provider (goal 07/07B). `LIVE_TRADING_ENABLED=false` is a
hard precondition; LIVE would need its own model (broker adapter, credentials custody, best
execution) before the Sponsor could enable it.

Legend — **Evidence** names the test or scan that proves the mitigation; **Residual** is what stays
open and who owns it. Test paths are relative to `apps/api/test/` unless noted.

## 1. System and trust boundaries

```
 browser ──TLS──▶ web (Next.js: CSP nonce, route guards, /api proxy)
    │                       │
    └──WS (same host)──▶ api (REST + WS gateway) ──▶ Postgres (kora_app role; audit INSERT/SELECT only)
                           │   ▲                 └─▶ Redis (market-data bus, last values, heartbeats)
          x-kora-service-token │                 └─▶ AI provider (HTTPS, key from env)
                           ▼   │
                     bot-runner ──▶ quant (internal network only)
```

Boundaries: (B1) internet → web/api; (B2) api → Postgres/Redis; (B3) service ↔ service
(runner ↔ api `/internal/*`, api/runner → quant); (B4) api → AI provider (untrusted output, untrusted
input content such as news); (B5) operators (admin, risk officer, auditor) → governance endpoints.

## 2. Assets

Account balances and positions (PAPER, but the integrity model must hold for LIVE); orders and the
kill switch; the hash-chained audit log; user credentials, TOTP secrets and recovery codes; session
tokens; appropriateness results (they gate `trader`); AI drafts; governance evidence and subject
access exports; signing keys (`KORA_DEV_IDP_PRIVATE_JWK`, `KORA_AUDIT_ANCHOR_JWK`), the service token,
the AI API key.

## 3. Threats by area

### 3.1 Authentication and sessions

| STRIDE | Threat | Mitigation | Evidence | Residual |
|---|---|---|---|---|
| S | Credential stuffing / brute force | scrypt password hashes; lockout after 10 failures; generic error for unknown user; `authThrottle` rate limit on every auth route | `lockout.int.test.ts`, `auth.int.test.ts` "wrong password → 401 generic", `security-hardening` "rate limits … 429" | Distributed attacks across IPs: WAF/bot protection at the edge (deployment, S9) |
| S | Stolen password | TOTP MFA mandatory for every non-novice role (`amr=otp` enforced by the global guard); novices may opt in | `auth.int.test.ts` "rejects a non-novice token without amr=otp" | Phishing-resistant factors (WebAuthn) post-RC |
| S | Lost authenticator used as a back door | Recovery codes (B-902): 10 one-time hashed codes, shown once, cannot replace the password step, regeneration needs TOTP, audited; MFA reset needs four-eyes | `security-hardening` recovery-code tests, `governance-four-eyes` "admin cannot approve the MFA reset they requested" | — |
| S/E | Stolen or leaked access token keeps working | Short-lived ES256 JWTs; server-side session state checked per request and at WS auth: logout revokes the `jti`, role change / MFA reset / disable invalidate older tokens | `security-hardening` "logout revokes", "revoked session cannot open a WebSocket", "role change ends … sessions", "disabled user" | Up to 2 s propagation to other replicas (local cache) |
| T | Token forgery / algorithm confusion | `jose` verification pinned to the issuer's JWKS, audience and ES256; dev IdP refuses `NODE_ENV=production` | `auth.int.test.ts` "rejects garbage"; config tests | Keycloak realm hardening verified only on deployment (B-001, Sponsor launch item) |
| I | Session cookie theft via XSS | Cookie `HttpOnly; SameSite=Strict`; `Secure` outside dev; nonce CSP with `strict-dynamic`, no inline script | `security-hardening` "session cookie is HttpOnly and SameSite=Strict"; `apps/web/e2e/auth.spec.ts` "web security headers" | — |
| T | CSRF on cookie-authenticated mutations | `SameSite=Strict` + mandatory `x-kora-csrf` header on unsafe cookie requests (bearer requests exempt) | `auth.int.test.ts` + `security-hardening` CSRF tests | — |
| S | Client IP spoofing to dodge per-IP limits | `KORA_API_TRUST_PROXY` / `KORA_TRUSTED_PROXY_HOPS` (B-015): X-Forwarded-For honoured only from configured hops | `apps/web/src/lib/forwarded.test.ts`, security-hardening | Must match the real ingress (deployment checklist) |
| E | Self-service privilege escalation to `trader` | Sign-up is novice only; `trader` only via the appropriateness assessment (B-018); self-assigned roles refused | `auth.int.test.ts` B-018 tests, `appropriateness.int.test.ts` | — |

### 3.2 Orders, OMS, risk and kill switch

| STRIDE | Threat | Mitigation | Evidence | Residual |
|---|---|---|---|---|
| T | Duplicate or replayed orders (retries, reconnects, chaos recovery) | `clientOrderId` unique per account with request hash; replay returns the stored order, a different body is 409 | `orders.int.test.ts`, chaos drill "no duplicate orders", load run duplicates = 0 | — |
| T | Order on stale or missing market data | Fill-safety verdict (stale quote, feed not up, old status) rejects `MARKET_DATA_STALE`; engine never fills on stale data | `feed-resilience.int.test.ts`, `docs/qa/chaos.md` | — |
| E | Bypassing pre-trade risk (limits, novice guardrails) | Risk evaluated server side inside the account-locked transaction; novice guardrails server enforced; limit breaches alert the risk console | `risk.int.test.ts`, `novice-guardrails.int.test.ts`, `risk-console.int.test.ts` | — |
| D | Order flooding | `orderThrottle` per client, per-account orders/minute risk limit, request body limits | `security-hardening` "order endpoints answer 429" | Edge DDoS protection (deployment) |
| D | Kill switch unreachable when the WS or Redis is down | REST fallback; kill switch reads/writes Postgres only; 1,000 child actions in one audit batch | `kill-switch.int.test.ts`, chaos Redis-down scenario | — |
| R | Trader denies an order or an override | Every order transition, fill, override and kill switch action audited in the hash chain with actor | `audit.int.test.ts`, `trading-integrity.int.test.ts` | — |
| I | Reading another user's orders, fills, positions | Owner scoping in services (account from the principal, never from input); authz matrix | `authz-matrix.int.test.ts` → `docs/security/authz-matrix.md`, module tests | — |
| E | LIVE trading switched on by configuration drift | `LIVE_TRADING_ENABLED=true` refused at config load in api and runner; no broker adapter exists | config tests, `bot-runner` config test, `/health.liveTradingEnabled=false` (e2e) | Sponsor-only decision (charter) |

### 3.3 AI copilot and market intelligence

| STRIDE | Threat | Mitigation | Evidence | Residual |
|---|---|---|---|---|
| E | Prompt injection makes the model trade | The model has **no** order/robot tools: read-only tools as the user plus draft creation; a human confirms every draft; forbidden tool names refused | `ai.int.test.ts` "adversarial model cannot submit, amend or cancel orders or control robots" | — |
| T | Injected instructions in news or user text | Untrusted content wrapped as `<untrusted_data>`, stripped of instructions; evals include injection cases | `pnpm evals` (goal 07/07B eval suites) | Live-provider evals pending API key (Sponsor) |
| I | Cross-user data leakage through tools | Tools execute as the calling user through the same services and owner scoping | `ai.int.test.ts` "every tool works … as the user" | — |
| D / cost | Token-budget exhaustion | Per-user and global daily budgets, rate limit, response cache; over-budget answers are friendly 200s | `ai.int.test.ts` budget tests, Grafana AI tokens/cost dashboard | — |
| R | Unrecorded AI suggestions | Every AI request, draft and decision audited | `ai.int.test.ts` "records the decision" | — |
| I | Personalised advice / misleading forecasts | Calibrated probabilities with citations, "not investment advice", no personalisation (goal 07B) | intel tests, evals | Legal copy review (Sponsor launch checklist) |

### 3.4 Admin and governance

| STRIDE | Threat | Mitigation | Evidence | Residual |
|---|---|---|---|---|
| E | A single admin grants roles or resets MFA to take over an account | Role changes end older sessions and force MFA enrolment; MFA reset and firm-halt resume need four-eyes (API + database trigger) | `auth.int.test.ts` "admin grants a role", `governance-four-eyes.int.test.ts` | — |
| E | Auditor changes data | `auditor` role is read-only (SoD); `kora_audit_reader` DB role | authz matrix (auditor column), `internal-audit.int.test.ts` | — |
| T | Audit log tampering | Append-only table (trigger blocks UPDATE/DELETE/TRUNCATE, runtime role has INSERT/SELECT only), SHA-256 hash chain, signed daily anchors (`KORA_AUDIT_ANCHOR_JWK` required outside dev/test) | `audit.int.test.ts` tamper test, `/audit/verify` | Object-lock storage for anchors (B-903, deployment) |
| I | Evidence / subject-access export leaks secrets or runs formulas in spreadsheets | Exports exclude password hashes, TOTP secrets and recovery codes; CSV neutralises formulas; only 2nd/3rd line export | `governance-evidence.int.test.ts`, `governance.unit.test.ts` CSV test, `compliance.int.test.ts` | — |
| R | Operator denies a governance action | Four-eyes requests and decisions audited with both actors | `governance-four-eyes.int.test.ts` | — |

### 3.5 WebSocket gateway

| STRIDE | Threat | Mitigation | Evidence | Residual |
|---|---|---|---|---|
| S | Cross-site WebSocket hijacking | Origin allow-list (`KORA_MD_WS_ORIGINS`), token auth message, revoked sessions refused (4401) | `ws-gateway.int.test.ts`, `security-hardening` | — |
| I | Subscribing to another user's private channels (`account:`, `positions:`, `risk:alerts`) | Channel authorisation by owner / role; MFA required for privileged roles | `ws-gateway.int.test.ts`, `risk-console.int.test.ts` | — |
| D | Connection or subscription exhaustion | Per-IP and per-user connection quotas (4429), per-socket subscription caps, slow-consumer close, conflation | `ws-quotas.int.test.ts`; load run 500 sockets, 0 errors | — |

### 3.6 Service to service and infrastructure

| STRIDE | Threat | Mitigation | Evidence | Residual |
|---|---|---|---|---|
| S | Forged runner calls to `/internal/*` | `x-kora-service-token` (≥ 32 chars) compared in constant time; accepted only on `/internal/*` | `robots.int.test.ts`, authz matrix | mTLS / network policy in the cluster (deployment) |
| I | Credentials in the repository | Secrets only from env/vault; history scan of every blob (detect-secrets + regex) with a reviewed dev-only allowlist | `scripts/security/secrets-history.py`, CI security job | — |
| T | Supply-chain compromise | Lockfile, pnpm `minimumReleaseAge` 7 days, `trustPolicy: no-downgrade`, `blockExoticSubdeps`; Actions pinned to SHAs; `pnpm audit` and `pip-audit` gates; Trivy image scan | `docs/security/scans.md` | Trivy runs only in CI (no Docker here) |
| I | Plaintext DB/Redis traffic | Staging/production refuse non-TLS `DATABASE_URL`/`REDIS_URL` unless explicitly allowed | `apps/api/src/config/config.test.ts` | — |
| I | Metrics endpoint leaks operational data | `/metrics` fails closed outside dev/test without a token | `security-hardening` "metrics fail closed" | — |
| D | Dependency outage (feed, Redis, quant, AI) | Graceful degradation, stale badges, no orders on stale data | `docs/qa/chaos.md` | — |

## 4. Deferred items (with owners)

| Item | Why deferred | Owner | When |
|---|---|---|---|
| DAST (OWASP ZAP baseline) | No staging and ZAP not installable here (GitHub downloads blocked) | S9 | `zap-baseline` job in `.github/workflows/release.yml` runs against staging after the manual approval |
| Container image scan (Trivy) | No Docker daemon here | S9 / S10 | CI security job (B-008) |
| Keycloak realm hardening review | No Keycloak here | S9 | Sponsor launch checklist (B-001) |
| Penetration test by a third party | Needs a deployed environment | Sponsor | Before market launch |
