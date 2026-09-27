# IRTC R1 corrections: application security

- Seat: IRTC R1 (application security) findings, corrected by an IRTC corrector (independent of the
  delivery seats S1 to S10, CHARTER §6).
- Scope: R1-01, R1-03, R1-04, R1-05, R1-06, R1-07, R1-08, R1-09, R1-11.
- Out of scope (other correctors): R1-02 (admin role grants, four-eyes) and R1-10 (the
  `ai-draft-accepted` source) are owned by the R4 corrector. `admin.controller.ts`, the four-eyes
  engine and draft acceptance were not edited here. The tests only *call* `PUT /admin/users/:id/roles`
  to demote a user.
- Policy values: chosen by the Product Owner under delegated Sponsor authority (CHARTER §7), taking the
  conservative option each time. They are recorded in `docs/open-questions.md` as OQ-SA1 to OQ-SA5.
- Method, for each finding:
  1. confirm it (the reviewer's reproduction, plus a new regression test);
  2. show the test failing on the unfixed code;
  3. fix the root cause;
  4. show the test passing.

  The logs of the failing runs are summarised below. Tests live in `apps/api/test/` unless a path says
  otherwise.

## Summary

| ID | Severity | Verdict | Fix (commit) | Regression test |
|---|---|---|---|---|
| R1-01 | High | Confirmed, fixed | Separate second-factor counter and lock (`e708721`) | `auth-bruteforce.int.test.ts` (R1-01 block) |
| R1-03 | Medium | Confirmed, fixed | WS re-check on subscribe, on revocation (with Redis relay), and by a sweep (`491eecd`) | `ws-revocation.int.test.ts` |
| R1-04 | Medium | Confirmed, fixed | Password back-off that does not enumerate and has no hard lock (`e708721`) | `auth-bruteforce.int.test.ts` (R1-04 block) |
| R1-05 | Medium | Confirmed, fixed | Peer-address preload plus per (IP, account) sign-in limits (`2e0a1f1`) | `rate-limit-attribution.int.test.ts`, `apps/web/src/lib/peer-address.test.ts`, `apps/web/e2e/proxy-attribution.spec.ts` |
| R1-06 | Medium | Confirmed, fixed | Strict same-origin `next=` (`b66260c`) | `apps/web/src/lib/safe-next.test.ts`, `apps/web/e2e/auth.spec.ts` |
| R1-07 | Low | Confirmed, fixed | Step-up counts towards the second-factor lock, and a lock ends sessions (`e708721`) | `auth-bruteforce.int.test.ts` (R1-07 block) |
| R1-08 | Low | Confirmed, fixed | Whole-chain verify limited to auditors, risk officers and admins; own-scope verify for everyone else; rate limit (`626ae26`) | `audit-verify-access.int.test.ts` |
| R1-09 | Low | Confirmed, fixed | Segregation-of-duties check before grading: clean 409, audited (`3d36a79`) | `appropriateness-abuse.int.test.ts` (R1-09) |
| R1-11 | Low | Confirmed, fixed (5 items) | Redis auth, docs only in dev and test, dev IdP refused in staging, CSV formula neutralisation (`1409d3d`); anti-sybil limits (`3d36a79`) | `config.test.ts`, `services/bot-runner/src/runner.test.ts`, `api-docs-exposure.int.test.ts`, `apps/web/src/lib/sim/sim.test.ts`, `appropriateness-abuse.int.test.ts` (R1-11) |

## R1-01: TOTP lockout reset by every correct password (High)

- **Verdict:** confirmed.
  - `recordLoginSuccess` ran after the password check and set `failed_logins = 0, locked_until = NULL`.
  - TOTP failures shared that counter, so each correct password restarted the 10-failure budget.
- **Root cause:** one counter mixed two factors, and success on the first factor reset it.
- **Fix:**
  - New columns (migration `0140_auth_bruteforce.sql`): `users.mfa_failed_count` and `mfa_lock_count`. `users.locked_until` now means "second factor locked until".
  - Every failed second factor (TOTP, recovery code or step-up) goes through `UsersRepository.recordMfaFailure`.
  - Five consecutive failures lock the second factor for 15 min. Each renewal doubles the lock, up to 24 h.
  - While the count stays at or above 5, one failure after the lock expires renews it.
  - Only `recordMfaSuccess` resets the count. It runs after a successful TOTP code, recovery code or step-up.
  - The password step calls `recordPasswordSuccess`, which never touches the second-factor fields.
  - A locked second factor answers `403 mfa_locked`, including for the right code and for recovery codes.
  - Policy: `apps/api/src/auth/auth-policy.ts` (unit test `auth-policy.test.ts`), OQ-SA1.
- **Regression test:** `auth-bruteforce.int.test.ts`:
  - "27 wrong TOTP codes over 3 password cycles lock the second factor; the right code is then refused" (the reviewer's scenario);
  - "a correct password never resets the second-factor failure count";
  - "a successful second factor resets the count; the lock expires and doubles on renewal".
- **Before** (unfixed code):
  ```
  × 27 wrong TOTP codes … the right code is then refused      → expected false to be true   (never locked)
  × a correct password never resets the second-factor count  → expected 401 to be 403
  × a successful second factor resets …                      → expected 403 "Forbidden", got 401
  ```
- **After:** all 7 tests in the file pass. The reviewer's `f1.log` showed `after 27 wrong TOTP codes: correct code -> 200 ok`. The same sequence now ends with `403 mfa_locked`, and the database shows `mfa_failed_count >= 5` with `locked_until` in the future.

## R1-07: step-up TOTP had no lockout (Low)

- **Verdict:** confirmed. `verifyStepUp` audited a failure but counted nothing, so a stolen session gave 20 guesses per minute at `POST /auth/mfa/recovery-codes`.
- **Fix:**
  - Step-up codes share the R1-01 second-factor counter and lock.
  - A locked second factor refuses step-up. Robot promotion and recovery-code regeneration both go through `verifyStepUp`.
  - When step-up failures reach the lock, `SessionsService.invalidateAll` ends every session of the user. The session that produced the failures may be stolen.
- **Regression test:** `auth-bruteforce.int.test.ts` "5 wrong step-up codes lock the second factor and end every session of the user". The test checks:
  - `/me` with the old token returns 401;
  - a fresh login with the correct code returns `403 mfa_locked`.
- **Before:** `→ expected 401 "Unauthorized", got 200 "OK"` (the session survived). The reviewer's `f8.log` showed 19 wrong codes followed by a correct one that issued 10 new recovery codes.
- **After:** passes.
- **Not done:** the reviewer also suggested requiring a sign-in within the last 5 minutes before recovery codes can be regenerated. That was not added, because the lock plus the ending of every session already closes the path. It is recorded as an optional follow-up for S9.

## R1-04: lockout DoS and account enumeration (Medium)

- **Verdict:** confirmed.
  - Eleven unauthenticated requests locked any existing account for 15 min, with unlimited renewals.
  - The lock refused even the correct password.
  - `403 locked` appeared only for existing accounts.
- **Root cause:**
  - A hard per-account lock at the password step, keyed on the account id.
  - A distinct error code for the locked state.
- **Fix:**
  - The password step never hard-locks. `DevIdpService.login` applies progressive back-off from the table `auth_login_backoff`.
  - The back-off is keyed on SHA-256 hashes of the e-mail string, never on whether the account exists:
    - per (e-mail, IP): 5 free failures, then 30 s doubling, capped at 15 min;
    - per e-mail over all IPs: 20 free failures, then 60 s doubling, capped at 15 min.
  - The per-e-mail back-off is not applied to IPs where the owner completed a sign-in in the last 90 days. These are stored as hashes in `auth_known_ips`.
  - Attempts refused during a back-off are not counted, so renewals are bounded by the attacker's own real failures. Counters decay after 24 h without a failure.
  - The refusal is `429 too_many_attempts` with a `Retry-After` header. It is identical for unknown and existing e-mails, and the body carries no timing detail.
  - The known-IP lookup runs whether or not the account exists, so response time does not reveal it either.
  - The obsolete `lockout.int.test.ts` asserted the vulnerable behaviour ("even with the right password → 403 locked"). It was removed and replaced by the tests below.
  - Policy: OQ-SA1.
- **Regression test:** `auth-bruteforce.int.test.ts`:
  - "existing and unknown accounts get identical answers, including when backed off": 12 attempts each, deep-equal status and body;
  - "an attacker backing off one IP cannot lock the owner out from another IP";
  - "a distributed attack backs off unknown IPs account-wide, but the owner on a known IP still signs in; back-off is capped".
- **Before:**
  ```
  × existing and unknown accounts get identical answers …  → expected [ …(12) ] to deeply equal [ …(12) ]
  × an attacker backing off one IP cannot lock the owner out → expected 403 to be 429
  × a distributed attack …                                  → expected 403 to be 429
  ```
- **After:** all pass.
- **Residual:** an attacker behind the same address as the owner (the same NAT) can delay that address by up to 15 min. Owner notification by e-mail waits for Keycloak (B-001). Every lock and back-off is audited (`auth.mfa_locked`, `auth.login_backoff`).

## R1-05: every web user shared one rate-limit bucket (Medium)

- **Verdict:** confirmed.
  - With `KORA_TRUSTED_PROXY_HOPS=0` (the default), the web `/api` proxy reported everyone as `127.0.0.1`.
  - Next.js only fills `X-Forwarded-For` with the socket address when the client sent none (`??=` in `base-server.js`).
  - Route handlers cannot see the socket.
- **Root cause:** in the direct topology the proxy had no trustworthy source for the client address, and the safe fallback was a single shared constant.
- **Fix:**
  - `apps/web/peer-address.cjs` is a CommonJS preload (`node --require`). It stamps every incoming request with the TCP peer in `x-kora-peer-addr`, overwriting any client value, before Next.js sees it.
  - It is preloaded by:
    - `pnpm dev` and `pnpm start` (`apps/web/package.json`);
    - the Playwright web server;
    - the Docker image (`CMD node --require ./apps/web/peer-address.cjs apps/web/server.js`).
  - `clientAddress()` in `apps/web/src/lib/forwarded.ts` chooses the address as follows:
    - hops ≥ 1: the entry the trusted ingress appended;
    - hops = 0: the stamped peer, trusted only when the preload is loaded in the process (global flag);
    - otherwise: loopback, with a warning.
  - In staging and production the proxy answers 503 `proxy_misconfigured` rather than collapse every client into one address.
  - API: sign-in routes use a new opt-in `account` throttler keyed on (IP, account):
    - the account is the e-mail, or the subject of the MFA or session token, decoded only to pick a bucket;
    - limit: `KORA_AUTH_RATE_LIMIT` (20/min).
  - The per-IP `default` limit on those routes is `KORA_AUTH_IP_RATE_LIMIT` (default 5×). Policy: OQ-SA2.
- **Regression tests** (all at the shipped defaults, no raised limit env):
  - `rate-limit-attribution.int.test.ts`:
    - "20 junk sign-ins against one account from one IP do not block a different account from that IP";
    - "one IP spraying many accounts still hits a per-IP ceiling".
  - `apps/web/src/lib/peer-address.test.ts`: a real HTTP server with the preload; clients from loopback aliases 127.0.0.2 and 127.0.0.3; spoofed `X-Forwarded-For` and `x-kora-peer-addr` are ignored.
  - `apps/web/e2e/proxy-attribution.spec.ts`: through the real Next.js proxy, two source addresses get separate API buckets, and a spoofed header does not escape its bucket.
- **Before:**
  ```
  web  × two different clients get two different addresses   → expected '127.0.0.1' to be '127.0.0.2'
  web  × a client-chosen X-Forwarded-For … is never trusted    → expected '127.0.0.1' to be '127.0.0.2'
  api  × 20 junk sign-ins … do not block a different account   → expected 429 to be 401
  api  × one IP spraying many accounts still hits a ceiling    → expected true to be false
  ```
- **After:** all pass. The e2e result is in the final gate below.
- **Deployment note:** behind an ingress, set `KORA_TRUSTED_PROXY_HOPS` to the real hop count and `KORA_API_TRUST_PROXY` to the web tier's network.
- **Not done:** the reviewer's optional idea of an authenticated-user (`sub`) tracker for post-login routes. Correct IP attribution removes the platform-wide bucket; a per-user tracker is left to S9 if load data asks for it.

## R1-03: WebSocket kept roles and access after logout, demotion or disable (Medium)

- **Verdict:** confirmed. `sessions.isActive` ran only in `authenticate`. Later subscriptions used the cached `conn.principal.roles`, and existing subscriptions were never re-checked.
- **Fix:**
  - `MarketDataGateway`:
    - every `subscribe` re-checks the session uncached (`isActive(p, { fresh: true })`) and closes the socket with 4401 when it is no longer live;
    - it listens to the new `SessionsService.events` (`revoked`, emitted by logout with the token id, and by `invalidateAll` with the valid-after second, which role changes, MFA resets and locks use) and closes the covered sockets at once;
    - it relays revocations over Redis (`<md prefix>sessions:revoked`), so every replica closes its sockets;
    - a sweep (`KORA_WS_SESSION_SWEEP_MS`, default 15 s) batch-checks all open sockets with two queries (`SessionsService.inactive`), which catches out-of-band changes such as a user disabled in the database.
  - Policy: OQ-SA3.
- **Regression test:** `ws-revocation.int.test.ts`:
  - logout mid-socket;
  - a demoted risk officer holding `risk:alerts` and another account's `orders:` (no later subscribe is granted);
  - subscribe after an out-of-band disable;
  - logout on replica 1 closing the socket on replica 2, with replica 2's sweep disabled;
  - the sweep.
- **Before:** all 4 original cases failed with `timeout waiting for close`: the socket stayed open. The reviewer's `f2.log` showed a revoked socket subscribing and then receiving the victim's order events.
- **After:** all 5 pass.

## R1-06: post-login open redirect through `/login?next=/\evil.host` (Medium)

- **Verdict:** confirmed. `safeNext` refused only `//`. The WHATWG URL parser treats `\` as `/` and drops tab, CR and LF.
- **Fix:** `apps/web/src/lib/safe-next.ts` accepts `next` only when all of the following hold. Otherwise it falls back to `/`.
  - It starts with a single `/`.
  - It contains no backslash and no ASCII control character, in its raw form or after up to 3 rounds of percent-decoding.
  - Its path part has no `%2F`, `%5C` or `%25`.
  - It keeps a fixed origin after `new URL` resolution.

  The value returned is the normalised `pathname + search + hash`.
- **Regression tests:**
  - `apps/web/src/lib/safe-next.test.ts`: the reproduction, `\`, tab, CR, LF, NUL, `%5C`, `%2F`, `%09`, double encoding, malformed escapes, and an "always same origin" property check.
  - `apps/web/e2e/auth.spec.ts` "post-login redirect refuses an off-site next": four hostile values, a real sign-in in Chromium, and an assertion that the browser never requests `evil.example`.
- **Before:** 5 of the 6 unit tests failed, for example `expected '/\evil.example/phish' to be '/'`. The reviewer's `f9.log` showed the final URL `http://evil.example/phish`.
- **After:** the unit tests pass. The e2e result is in the final gate below.

## R1-08: `GET /audit/verify` open to every user (Low)

- **Verdict:** confirmed. Any user could run the O(N) re-hash at 600 calls/min and learn the platform event count and head hash.
- **Fix:**
  - Auditors, risk officers and admins get the whole chain (`scope: "chain"`). Concurrent calls share one pass (single flight).
  - The result is deliberately not cached across calls. A cached "valid" would hide a tamper until the next append; `audit.int.test.ts` tampers without appending.
  - Everyone else gets `AuditService.verifyOwn` (`scope: "own"`). Their visible events (the newest 5,000) are recomputed and linked to the stored hash of each predecessor. No platform count or head hash is returned.
  - This keeps the master goal's "a user or auditor can verify" for the user's own records. The web banner says "N of your events recomputed and linked into the chain".
  - The route has its own limit, `KORA_AUDIT_VERIFY_RATE_LIMIT` (10/min per client). Policy: OQ-SA4.
- **Regression test:** `audit-verify-access.int.test.ts`:
  - self-scoped for a trader, with no platform totals;
  - whole chain for an auditor and a risk officer;
  - a tampered own event is still reported;
  - the 11th call in a minute returns 429.
- **Before:** all 4 failed (full count returned, no scope, no limit).
- **After:** all pass. `audit.int.test.ts` "50 concurrent writers" now verifies as an auditor.

## R1-09: an auditor passing appropriateness got a 500 (Low)

- **Verdict:** confirmed. The grant path never called `rolesConflict`. The `0090` trigger threw, the attempt rolled back with no audit record, and the client saw a generic 500 (reviewer's `f10.log`).
- **Fix:**
  - `AppropriatenessController` checks `rolesConflict([...roles, 'trader'])` before grading.
  - On a conflict it audits `appropriateness.refused` and answers `409 segregation_of_duties` with a message. No attempt is stored.
  - The check runs again inside the transaction, for a role granted in the meantime. The DB trigger stays as the backstop.
  - The questionnaire reports such accounts as `eligible: false`, and the page explains why.
- **Regression test:** `appropriateness-abuse.int.test.ts` "an auditor passing the assessment gets a clean, audited 409 and keeps their roles".
- **Before:** failed: `eligible` was true, and the reviewer's repro showed a 500 on submit.
- **After:** passes.

## R1-11: hardening gaps (Low, five items)

| Item | Fix | Test / evidence |
|---|---|---|
| Redis without authentication | See the list below this table | `config.test.ts` "require Redis authentication"; `runner.test.ts` "requires Redis authentication"; manual check below |
| Swagger exposed in staging | `/docs` and `/openapi.json` only when `KORA_ENV` is `dev` or `test` (`config.apiDocs`) | `api-docs-exposure.int.test.ts` boots the api as staging. Before: `→ expected 200 to be 404`. After: 404 |
| Dev IdP accepted in staging with ephemeral keys | `AUTH_PROVIDER=dev` refused in staging unless `KORA_ALLOW_DEV_IDP=true`, and then only with persistent signing and MFA keys; production always refuses | `config.test.ts` "the dev IdP is refused in staging …" (failed before) |
| Simulator CSV formulas | `apps/web/src/lib/sim/csv.ts` prefixes text cells starting with `= + - @ \t \r` with `'`; numbers and numeric strings such as `-12.50` stay numeric | `sim.test.ts` "neutralises spreadsheet formulas" (failed before: `=HYPERLINK(…)` exported raw) |
| Sybil answer-key walk | Per-IP opt-in `long` throttler: sign-up ≤ `KORA_SIGNUP_RATE_LIMIT_PER_HOUR` (10) per IP per hour; assessment attempts ≤ `KORA_APPROPRIATENESS_IP_LIMIT_PER_DAY` (10) per IP per day across accounts (OQ-SA5). The suites raise both; the regression tests run at the defaults | `appropriateness-abuse.int.test.ts` R1-11 tests. Before: `→ expected 201 to be 429` and `→ expected 200 to be 429` |

Redis authentication changes:

- `scripts/dev-db.sh` starts Redis with `requirepass` when `KORA_REDIS_PASSWORD` is set. The password is written to a 0600 config file, never on the command line.
- `.env.example` sets `KORA_REDIS_PASSWORD` and puts it in `REDIS_URL`.
- The compose reference requires it.
- The API and the bot runner refuse a password-less `REDIS_URL` in staging and production. The local-compose TLS escape hatch does not waive this.
- Existing `.env` files without `KORA_REDIS_PASSWORD` keep an open local Redis. The shared dev instance was not changed.

**Redis authentication, manual check.** The worktree's `dev-db.sh` (Postgres steps stripped) started a separate `redis-server` on scratch port 56391 with `KORA_REDIS_PASSWORD`. The shared dev instance was never touched, and the scratch server was stopped afterwards.

```
[dev-db] redis started on 127.0.0.1:56391 (password required)
--- no password:     NOAUTH Authentication required.
--- wrong password:  AUTH failed: WRONGPASS invalid username-password pair or user is disabled.
--- right password:  PONG
--- requirepass is not on the command line:  redis-server 127.0.0.1:56391
ioredis (the api/runner client): no password -> refused; wrong password -> refused; right password -> PUBLISH ok
REDIS_URL=redis://:<password>@127.0.0.1:56391 pnpm vitest health + ws-gateway + ws-revocation → 15/15 passed
```

## Files changed (main ones)

- **API, auth:**
  - `apps/api/migrations/0140_auth_bruteforce.sql`
  - `apps/api/src/auth/{auth-policy.ts, dev-idp.service.ts, users.repository.ts, sessions.service.ts, auth.controller.ts}`
  - `apps/api/src/common/auth-throttle.ts`
  - `apps/api/src/app.module.ts`
- **API, WebSocket:** `apps/api/src/market-data/{gateway.ts, md-config.ts}`
- **API, other:**
  - `apps/api/src/audit/{audit.service.ts, audit.controller.ts}`
  - `apps/api/src/appropriateness/appropriateness.controller.ts`
  - `apps/api/src/config/config.ts`
  - `apps/api/src/create-app.ts`
  - `apps/api/src/compliance/subject-access.service.ts` (exports the new counters and known-IP hashes)
- **Web:**
  - `apps/web/peer-address.cjs`
  - `apps/web/src/lib/{forwarded.ts, safe-next.ts, sim/csv.ts}`
  - `apps/web/src/app/api/[...path]/route.ts`
  - `apps/web/src/components/{auth/AuthFlow.tsx, AuditLog.tsx, Appropriateness.tsx}`
  - `apps/web/{package.json, playwright.config.ts, Dockerfile}`
- **Bot runner:** `services/bot-runner/src/config.ts`
- **Infrastructure and configuration:** `scripts/dev-db.sh`, `infra/docker-compose.yml`, `.env.example`
- **Docs:**
  - `docs/security/threat-model.md`
  - `docs/adr/0101-dev-identity-provider.md` (amended)
  - `docs/open-questions.md` (OQ-SA1 to OQ-SA5)

## Open items and owners

| Item | Owner |
|---|---|
| R1-02 (single admin defeats four-eyes) and R1-10 (spoofed `ai-draft-accepted`) | R4 corrector (separate worktree) |
| Throttler storage is in-memory per api replica. The per-IP sign-up and assessment limits and the sign-in limits multiply by the replica count until a shared (Redis) throttler store is added | S9 (backlog) |
| Owner notification (e-mail) on second-factor lock or back-off | S9 with Keycloak (B-001) |
| Optional: require a recent sign-in (`auth_time`) for recovery-code regeneration; a per-user (`sub`) tracker on post-login routes | S9 |
| Deployment: set `KORA_TRUSTED_PROXY_HOPS` and `KORA_API_TRUST_PROXY` to the real ingress; a Redis ACL user per service | Operations / S9 (deployment checklist) |
| `services/bot-runner` "halts … within milliseconds" unit test failed once in the first gate run (`haltedAccounts` 11 instead of 1) and passed on re-run. It appears to be cross-talk from other sessions' tests on the shared dev Redis (the kill-switch channel is not namespaced per test). Not caused by these changes | R6 (test integrity) |

## Final gate (2026-09-27, worktree databases `kora_fix_r1_test` / `kora_fix_r1_e2e`, e2e ports 4061/3061/8061/4161)

| Step | Result |
|---|---|
| `pnpm build` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` (with coverage gates) | pass: api 157, web 87, domain 185, ui 114, market-data 72, sdk 16, bot-runner 12, ai-evals 4. The first run hit the bot-runner kill-switch cross-talk flake noted above; the re-run passed |
| `pnpm test:integration`, run 1 | 45 files, 269 tests passed |
| `pnpm test:integration`, run 2 | 45 files, 269 tests passed |
| `pnpm test:e2e` | 69 passed |
| `pnpm py:check` | 164 passed, coverage 97 % |
| History secrets scan (`scripts/security/secrets-history.py`, detect-secrets 1.5.0) | 284 findings, 284 reviewed (five test-only literals added to the allowlist) |

**Other checks.**

- **R1-06 e2e on unfixed code.** The pre-fix `AuthFlow.tsx` was restored temporarily and rebuilt. The new e2e test then failed for `/%5Cevil.example/phish` and `/%09/evil.example/phish`: `Received string: "http://evil.example/phish"`. The fixed build passes all four values.
- **Earlier integration run.** A run made while another session was loading the machine (load average above 13 on 4 CPUs) failed two timing- or data-sensitive tests: `preview.int.test.ts` (`riskMs < 5` measured 6.1 ms) and a `strategies.int.test.ts` OOS trade count. Neither touches the changed code. Both passed on re-run and in the two final runs.
