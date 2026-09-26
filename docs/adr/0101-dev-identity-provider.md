# ADR 0101 — Identity: OIDC abstraction, dev IdP and TOTP MFA

- Status: Accepted (2026-09-26)
- Deciders: S9 (security, lead), S3, Project Owner

## Context

Goal 01 requires OIDC login, TOTP MFA for `trader`, `quant`, `risk_officer` and `admin`, and RBAC guards in both NestJS and Next.js. Keycloak cannot run in the build environment (ADR 0000), and tests must not depend on it.

## Decision

### Token contract (both providers)

The API accepts a JWT verified against a JWKS. The claims it uses are:

| Claim | Meaning |
|---|---|
| `iss` | must equal the configured issuer |
| `aud` | must contain `kora-api` |
| `sub` | user id (UUID) |
| `realm_access.roles` | subset of `novice, trader, quant, risk_officer, admin` (Keycloak shape) |
| `amr` | includes `otp` when the session passed TOTP |
| `exp`, `iat`, `jti` | standard |

`AuthGuard` builds a `Principal { sub, roles, mfa, email }`.
- `@Public()` opts a route out of authentication.
- `@Roles(...roles)` requires any one of the listed roles.
- Every non-novice role implies MFA: a token that carries such a role without `amr: otp` is rejected with `403 mfa_required`. This is enforced globally, not per route, so a missing decorator cannot bypass it.

### Dev IdP (`AUTH_PROVIDER=dev`, default in dev/test)

- `POST /auth/signup` takes `{email, password, displayName, accountType: novice|trader}`. `quant`, `risk_officer` and `admin` can only be granted by an admin through `PUT /admin/users/:id/roles` (audited).
- Passwords: scrypt (N = 2^17 by default, configurable via `KORA_SCRYPT_N` for tests), per-user salt, constant-time compare. Minimum length 12.
- Login is a two-step flow when MFA applies:
  - `POST /auth/login` returns `{status: "ok"}` (novice), `{status: "mfa_required", mfaToken}` or `{status: "mfa_enrollment_required", mfaToken}`.
  - The `mfaToken` is a 5-minute JWT with `purpose: "mfa"`. It is never accepted as an access token.
- `POST /auth/mfa/enroll` returns an `otpauth://` URI and a base32 secret.
- `POST /auth/mfa/verify` checks a code (±1 step window, replay of the same or an older step rejected) and then issues the access token with `amr: ["pwd","otp"]`.
- TOTP secrets are encrypted with AES-256-GCM under `KORA_MFA_ENC_KEY`. In dev an ephemeral key is generated with a warning.
- Signing: ES256 key from `KORA_DEV_IDP_PRIVATE_JWK`, or ephemeral in dev. JWKS is served at `/auth/jwks.json` and discovery at `/auth/.well-known/openid-configuration`.
- Access token: 30 min. It is set as an `HttpOnly; SameSite=Strict; Path=/` cookie `kora_at` (`Secure` outside dev) and also returned in the body for API clients.
- Rate limit on `/auth/*` (throttler, `KORA_AUTH_RATE_LIMIT` per minute).
- Every auth event (signup, login ok/fail, mfa enrol/verify, role change) is written to the audit log. No passwords, secrets or codes are ever logged.
- It refuses to boot when `NODE_ENV=production`.

### Keycloak (`AUTH_PROVIDER=keycloak`)

- Realm `kora` in `infra/keycloak/realm-kora.json`:
  - realm roles for the five roles;
  - clients `kora-web` (confidential, BFF code flow + PKCE) and `kora-api` (audience);
  - a browser flow with a *conditional OTP* sub-flow triggered by role (trader/quant/risk_officer/admin);
  - the `amr` protocol mapper, so the same guard works.
- The web login redirects to the api BFF endpoints `/auth/oidc/start` → Keycloak → `/auth/oidc/callback`. These set the same cookie. Implemented in goal 01, **not exercised** without Keycloak (BACKLOG B-001).

### Next.js route guards

`apps/web/middleware.ts` verifies the `kora_at` cookie against the api JWKS (jose). It then:
- redirects anonymous users to `/login`;
- **rewrites** forbidden routes to `/forbidden` with HTTP 403, for example `/robots/*` for a principal whose only role is `novice`.

Route rules live in `apps/web/src/lib/route-rules.ts` and have unit tests. The API enforces the same rules again. The web guard is only UX.

## Consequences

- Tests create users through the real sign-up endpoint. They compute TOTP codes from the returned secret and get real tokens. No test-only auth bypass exists.
- Refresh tokens and server-side session revocation are deferred (BACKLOG B-002). Access tokens are short-lived.
