# Keycloak realm `kora`

`realm-kora.json` is imported by the compose `keycloak` service (`start-dev --import-realm`). It defines:

- **Realm roles:** `novice` (default), `trader`, `quant`, `risk_officer`, `admin`. The last four are composites of the marker role `mfa_required`.
- **Browser flow `kora browser`:** username and password, then a *conditional OTP* sub-flow that applies when the user has `mfa_required`. Users without a TOTP credential are asked to set one up (`userSetupAllowed`).
- **Clients:**
  - `kora-web`: confidential BFF client, code flow with PKCE S256. The redirect URI is `${WEB_ORIGIN}/api/auth/oidc/callback`.
  - `kora-api`: bearer-only audience.
- **Client scope `kora-api-audience`:** gives `aud=kora-api`, `realm_access.roles`, `amr` and `email`. This is the same claim contract the api guard uses for the dev IdP (ADR 0101).
- **Placeholders:** `${KEYCLOAK_CLIENT_SECRET}` and `${WEB_ORIGIN}` are resolved from the container env at import.
- **Users:** none. Never commit users or credentials.

**Status:** not exercised in goal 01, because the build environment has no Docker. The Keycloak end-to-end test is BACKLOG B-001.
