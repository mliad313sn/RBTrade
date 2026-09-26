# Plan 08 — Novice view (desktop + mobile PWA)

Lead seats: S1 (principal product designer), S6 (frontend engineer), S8 (risk and compliance).
Inputs: master goal (including the 2026-09-26 scope amendment: global markets, appropriateness B-018
done in goal 03), goal 08, charter, STATUS (goal 03 questionnaire engine, preview contract and novice
risk rules; goal 04 reusable helpers; goal 05 Practice; goal 06 templates API and B-614), BACKLOG items
assigned to 08 (B-013, B-017, B-504, B-505, B-506, B-306, B-614), open question OQ-Q1, and
`design/prototype/Novice.png` (desktop reference, 1440 × 900).

Parallel work: goal 07 (AI copilot) is built in the main tree at the same time (`apps/api/src/ai`, AI
strip, robots copilot drawer, `services/ai-evals`, migrations `0070+`). This goal owns the novice routes
and components, onboarding, i18n, the PWA, the novice guardrail API, and migrations `0080+`. Shared
files (STATUS G8 row and section, BACKLOG B-801+, open questions, app shell, `app.module.ts`,
Playwright config, `.env.example`, lockfile) get small additive edits only.

## 1. Decisions up front

| Topic | Decision | Why |
|---|---|---|
| Who is guarded | The goal 03 rule stays: guardrails apply to **novice-only users and to anyone in the Novice view** (`OmsService.isNovice`). Every new rule below hangs off the same flag, so the Pro and Novice views share one engine and one risk path. | Charter §4 "one engine, two audiences". |
| Stop required, market only, no leverage | Already server-side (`NOVICE_STOP_REQUIRED`, `NOVICE_ORDER_TYPE`, `NOVICE_LEVERAGE`). Goal 08 adds API tests for each "novice cannot" criterion and keeps the rules in `evaluateRisk`. | Acceptance 1. |
| Leverage unlock | Leverage is **off** by default: gross exposure ≤ 1 × equity (`noviceMaxLeverage = 1`). A novice can ask for borrowing only after passing the knowledge check; turning it on is a *loosening*, so it waits 24 h, and the cap is `KORA_NOVICE_MAX_LEVERAGE` (SIMULATED placeholder 2×, OQ-R3). Turning it off is immediate. | Goal 08 §4: "knowledge checks … are needed to unlock leverage". Keeps "novice cannot use leverage" true until the check plus the wait. |
| Loosening waits 24 h | Account risk limits gain a `pending` map (`{field: {value, requestedAt, effectiveAt}}`) inside `accounts.risk_limits`. For guarded users, `PUT /accounts/me/settings` (the one server path, whichever screen calls it) classifies each change: tighter → applied now (and any pending loosening of that field is dropped); looser → pending until `now + KORA_NOVICE_LOOSEN_DELAY_HOURS` (24). `AccountsService.limits(account, now)` applies a pending value once its time has come, so no scheduler is needed and the rule holds in every process. Pro users keep today's behaviour (Pro loosening policy is OQ-R5, goal 09). Audited `account.settings_updated` with `{applied, pending}`. | Goal 08 §4; stateless and testable with a faked clock. |
| Monthly loss limit | New optional limit `monthlyLossLimit` (risk code `MONTHLY_LOSS_LIMIT`); month-start equity comes from `account_equity_snapshots` (period `month`, migration 0080). No platform default (`KORA_RISK_MONTHLY_LOSS_LIMIT` empty = none). | The design shows "Lost this month $214 of $600". |
| Cooling-off | Pure domain rule `coolingOff()`: after **3 losing trades today** (closing orders whose realised P&L net of fees is < 0), a **5 % loss today** (day P&L / day-start equity), or the daily loss limit being reached, a guarded user cannot open new exposure until the next UTC day (`NOVICE_COOLING_OFF`; closing is always allowed). Thresholds `KORA_NOVICE_COOLOFF_LOSING_TRADES`, `KORA_NOVICE_COOLOFF_DAILY_LOSS_PCT` (SIMULATED placeholders, OQ-R5). The UI shows a calm "Time for a break" card from `GET /novice/profile`. | Goal 08 §4. Stateless (from fills and snapshots), so no table and no drift. Day boundary in the customer's time zone is B-308 (goal 09). |
| Knowledge check | Questionnaire `knowledge-check` v1, `kind: knowledge_check`, 5 questions, pass mark 80 % (4/5), 60 min cool-down, SIMULATED placeholder content pending Compliance (OQ-C1), added to `QUESTIONNAIRE_FILES`. `GET /novice/knowledge-check`, `POST /novice/knowledge-check/attempts` (graded server-side, answers never stored, audited). A pass unlocks the *request* for leverage and is required for any novice robot to go live. French copy of the questions lives in the web i18n files, keyed by question and option id (the server text is the graded canonical version). | Goal 08 §4, questionnaire engine hand-over. |
| Robots in live mode | Novice template robots can never go live today: `POST /novice/auto-invest/:id/go-live` returns a refusal with a checklist (knowledge check, goal 06 promotion rules, `LIVE_TRADING_ENABLED`) and audits it. Pro robots keep the goal 06 promotion flow unchanged. | "Practice first; live requires the knowledge check plus the goal 06 promotion rules." |
| "Most you could lose" | The server builds the novice ticket: `POST /novice/ticket {symbol, direction, amount, safetyNetPct}` turns an amount in the **account currency** into a quantity on the registry grid (rounded down) and a stop price on the tick grid (rounded away from entry), then returns the exact `POST /orders` body plus the **unchanged `/orders/preview` response** for it. The UI shows `preview.lossIfStopHit.total` (price loss + entry and exit fees + conversion) and places exactly the returned body. A test compares 20 randomised tickets with a direct `/orders/preview` call and with the web formatter. | Acceptance 2; one source of truth. |
| Gain/loss scenario | Review sheet: "If the safety net is hit: −{lossIfStopHit.total}" and "If it moves the same amount your way: about +{lossIfStopHit.price − lossIfStopHit.costs}" (pure `scenarioGain`, unit-tested). | Traceability: both numbers come from the preview. |
| Curated assets (global) | Registry-driven: migration 0080 adds `instruments.novice_rank` and `instruments.novice_name` (`{"en": …, "fr": …}`, both required). Seeded with 10 instruments across five continents: EUR/USD, gold, Apple, bitcoin, SPY, the SIMULATED global fund KGEF, SAP (Xetra), Toyota (Tokyo), BHP (ASX), Naspers (JSE). `GET /novice/assets` returns them with session state and the minimum amount in the account currency. Changing the list is a registry update, not a code change. | Scope amendment (global) + "curated list of about 10". |
| Disclosure | New `apps/api/src/disclosures` module with a small interface for goal 09: `DisclosureRegistry.current(id, locale) → {id, version, locale, title, body, contentHash, values: {retailLossPct}, simulated}` and `DisclosureAcknowledgements.record/latest`. Today's implementation reads a versioned JSON (EN + FR) and the retail-loss figure from `KORA_DISCLOSURE_RETAIL_LOSS_PCT` (set by Compliance; empty → the literal placeholder `[XX]`, OQ-R1). `POST /disclosures/:id/acknowledgements {version, contentHash, locale}` refuses a stale version (409) and stores `disclosure_acknowledgements` (user, id, version, content hash, rendered figure, locale, time), audited `disclosure.acknowledged`. The Novice banner reads the same document. | Goal 08 §1; goal 09 can swap the registry implementation without touching callers. |
| Onboarding | `/onboarding`: 5 explainer screens (what trading is, spread and fees, safety net, borrowing, losses are normal), then the disclosure with acknowledgement, then loss limits with suggested defaults (`KORA_NOVICE_SUGGESTED_DAILY_LOSS_PCT` 1.5 % and `…_MONTHLY_…` 6 % of the practice balance, SIMULATED, matching the prototype's 150 / 600 on 10,000). The practice account is created automatically (`AccountsService.ensure`). `POST /novice/onboarding/complete` requires the current disclosure acknowledgement and both limits; `novice_profiles.onboarded_at` is set and audited. `/home` redirects novice-only users who have not finished. | Goal 08 §1. |
| Auto-invest (B-614) | **Decision:** a guarded server path, not the builder API. `GET /novice/auto-invest` lists the goal 06 templates with a 1–5 risk level and a plain rationale (catalogue in `packages/domain/src/novice/templates.ts`), OOS results from a stored template backtest when one exists, and the user's own paper results; never in-sample numbers. `POST /novice/auto-invest {templateId, amount}` creates a strategy from the template definition as-is (no editing), and a PAPER robot with `origin = 'novice_template'`, allocation ≤ `KORA_NOVICE_AUTOINVEST_MAX_PCT` (25 %) of equity, and limits derived from the user's own loss limits; then starts it. Pause, resume and stop via `/novice/auto-invest/:id/*`. The bot runner accepts a novice owner only for `novice_template` robots; their orders still go through the OMS with the novice guardrails (market + stop, no leverage, cooling-off). `/robots`, `/strategies`, `/backtests` stay builder-only. | Goal 08 §6, goal 06 hand-over. |
| i18n | Own tiny typed layer (`apps/web/src/lib/i18n`): `en.ts` is the source of truth, `fr.ts` is typed as the same shape (TypeScript fails on a missing key), a `t()` helper with `{var}` interpolation and a small inline-markup syntax `[text](term:id)` for glossary links. Locale from the `kora_locale` cookie (switcher in the novice top bar), else `Accept-Language`, else EN; `<html lang>` follows it. CI check: `pnpm --filter @kora/web i18n:check` (keys equal in both files, no empty values, every `t('…')` key used in novice code exists) plus a vitest test. | Goal 08 §9, B-013. No new dependency. |
| Readability | `pnpm --filter @kora/web readability` computes Flesch–Kincaid grade per string and for the whole EN novice corpus (markup and variables stripped) and writes `docs/novice/readability-report.md` (also a French score with the Kandel–Moles formula for information). The test fails if the EN corpus grade > 8 or any long string (≥ 12 words) > 8. | Goal 08 §9. |
| No gamification lint | ESLint `no-restricted-imports` and `no-restricted-syntax` on the novice files: any import path or JSX element whose name matches `confetti`, `streak` or `leaderboard` is an error. A vitest test runs ESLint on fixtures to prove the rule fires. | Goal 08 §9 and master non-negotiable. |
| "Explain this to me" slot | `apps/web/src/lib/novice/explain-slot.ts`: `registerExplainThis(Component)` and `<ExplainThis topic context />` with `ExplainSlotProps {topic, context, locale, mode: 'novice'}`; hidden unless `KORA_EXPLAIN_THIS=on` (default off) and a component is registered. No copilot code here (goal 07). | Parallel goal 07. |
| PWA | `app/manifest.ts` (standalone, start `/home`, theme and icons 192/512 + maskable), `public/sw.js` (offline shell only: precaches `/offline` and static assets, network-first navigation with the offline page as fallback, never caches `/api`, no `push` handler), registered from the novice shell. The offline page and an in-app banner show "Prices paused": nothing is priced or traded while offline. CSP gains `worker-src 'self'` and `manifest-src 'self'`; `/sw.js`, `/manifest.webmanifest`, `/offline` and the icons are public paths. | Goal 08 §8. |
| Mobile | 390 px first: one column, bottom tab bar (Home, Practice, Auto-invest, Learn), every interactive target ≥ 44 × 44 px (asserted in e2e), review sheet as a bottom sheet. No trading push notifications (none are implemented; the service worker has no push handler, asserted by a test). | Goal 08 §8. |
| Performance | The novice home is server-rendered with its data (account, profile, summary) so the headline number is in the first HTML (LCP). No chart library: the area chart is SVG. The Pro shell is loaded with `next/dynamic` so the novice bundle does not carry the terminal code. | Lighthouse mobile ≥ 85. |
| Saved scenarios (B-505) | `sim_scenarios` table (migration 0081) and `GET/POST/DELETE /sim/scenarios` (owner only, ≤ 50 per user, audited); Practice "Save this plan" and the list; the Pro simulator loads and saves too. | B-505. |
| Typed sim SDK (B-506) | `KoraClient` gains `simProject`, `simFromTrades`, `simPaperAnalytics`, `simPaperProject`, `simScenarios…` with types in `packages/sdk/src/sim-types.ts`; the web simulator and Practice use them. Novice methods likewise (`packages/sdk/src/novice-types.ts`). | B-506. |
| TOTP opt-in (B-017) | `POST /auth/mfa/opt-in` (signed-in user without MFA) returns an enrolment token and secret; `POST /auth/mfa/verify` completes it (existing endpoint). Settings shows "Two-step sign-in (optional)" with the QR code for novices. | B-017. |
| OQ-Q1 | S1 + S8 decision: keep the skill-free edge in Practice (honest, slightly negative typical year) and show the retail-loss disclosure line next to it (same registry, `[XX]%` until OQ-R1). Status "Decided (S1/S8), Sponsor to confirm". | OQ-Q1. |

## 2. Files

- `packages/domain/src/novice/`: `ticket.ts` (amount → qty, safety net → stop, `scenarioGain`, min amount), `limits.ts` (tighten/loosen classification, pending application), `cooling-off.ts`, `summary.ts` (`worstDip`, change since start), `templates.ts` (risk level 1–5, rationale keys), tests. `trading/risk.ts`: `MONTHLY_LOSS_LIMIT`, `NOVICE_COOLING_OFF`, `noviceMaxLeverage`, `monthPnl`.
- `apps/api/migrations/0080_novice.sql`, `0081_sim_scenarios.sql`.
- `apps/api/src/disclosures/` (module, registry interface + config implementation, acknowledgements repository, controller, `risk-warning.v1.json`).
- `apps/api/src/novice/` (module, config, profile/onboarding/limits/leverage/assets/summary/ticket controllers and service, knowledge check, auto-invest service, MFA opt-in controller), `apps/api/src/appropriateness/questionnaires/knowledge-check.v1.json`.
- Small edits: `AccountsService` (pending loosening, monthly limit), `OmsService.evaluate` (cooling-off, monthly, leverage cap), `robot-runtime.service.ts` (novice template exception), `robots.types.ts` (origin), `sim` (scenarios controller), `app.module.ts` (two modules), `questionnaire.service.ts` (one file in the list).
- `packages/sdk`: novice and sim methods + types.
- `apps/web`: `src/lib/i18n/*`, `src/lib/novice/*`, `src/components/novice/*`, routes `/home`, `/onboarding`, `/auto-invest`, `/learn`, `/learn/[lesson]`, `/learn/check`, `/offline`, `app/manifest.ts`, `public/sw.js`, icons, `NoviceShell` (i18n, language switch, PWA register, prices paused), `Practice` (i18n, saved scenarios), settings (TOTP opt-in), middleware/route rules (public PWA paths, CSP), ESLint rule, scripts `i18n-check.mjs` and `readability.mjs`.
- Tests: domain unit; api integration `novice-guardrails.int.test.ts`, `novice-ticket.int.test.ts`, `novice-onboarding.int.test.ts`, `novice-autoinvest.int.test.ts`, `sim-scenarios.int.test.ts`; web unit (i18n completeness, readability, gamification lint, formatters, explain slot, service worker); e2e `novice.spec.ts` (acceptance flow), `novice-mobile.spec.ts` (390 px, 44 px, axe), `pwa.spec.ts` (manifest, installability, offline "prices paused").
- Docs: this plan with results, ADR 0008, `docs/novice/readability-report.md`, `docs/novice/copy-review.md` (B-504 pack), STATUS G8 row + section, BACKLOG B-801+, open questions, README section, `.env.example`.

## 3. Schema (0080, 0081)

- `instruments`: `novice_rank smallint NULL`, `novice_name jsonb NULL` (object with non-empty `en` and `fr`); seeded for 10 instruments.
- `account_equity_snapshots.period` accepts `month`.
- `disclosure_acknowledgements` (append-only: user, disclosure id, version, content hash, values JSON, locale, created_at); `kora_app` SELECT/INSERT only.
- `novice_profiles` (user id PK, onboarded_at, updated_at).
- `robots`: `origin text NOT NULL DEFAULT 'builder' CHECK (origin IN ('builder','novice_template'))`, `template_id text NULL`.
- `sim_scenarios` (id, user, name, kind `practice|pro`, input JSON, created_at; unique user + name).

## 4. Risks

| Risk | Mitigation |
|---|---|
| Onboarding redirect breaks existing novice e2e specs | `apiSignIn(page, 'novice')` completes onboarding through the API by default (`{onboarded: false}` to opt out). |
| Loosening rule changes goal 03 behaviour for traders | Applies only to guarded users; existing risk tests (traders) unchanged. |
| Weekend: FX and equities closed | e2e trades bitcoin (24/7) and keeps the goal 04 `KORA_TRADING_SESSION_OVERRIDE=EURUSD` aid. |
| Lighthouse mobile perf ≥ 85 with Next | Server-rendered home data, SVG chart, Pro shell split out; measure and iterate. Lighthouse 13 has no PWA category, so installability is measured with Lighthouse 11 (`installable-manifest`) and Chromium's own `Page.getInstallabilityErrors` in e2e. |
| Parallel goal 07 edits the same shared files | Additive blocks at the end of `KoraClient`, `app.module.ts` imports, STATUS/BACKLOG rows; migrations numbered 0080+. |
| Shared Postgres on :55432 | Own databases `kora_novice`, `kora_novice_test`, `kora_novice_e2e`; e2e ports 4018/3018/8018/4118; Redis prefix `kora:e2e-novice:md:`. |

## 5. Test plan (maps to acceptance criteria)

1. **A novice cannot** (API integration, `novice-guardrails.int.test.ts`): place an order without a stop (`NOVICE_STOP_REQUIRED`, also via a limit and via the robot path); use leverage (`NOVICE_LEVERAGE` at 1×; request refused without the knowledge check; still refused within 24 h after the check; allowed only up to the cap after 24 h); open the strategy builder (403 on `/robots/builder`, `POST /strategies`, `POST /strategies/validate`, `POST /backtests`, `POST /robots`); loosen a limit without the 24 h wait (loosening is pending, the old limit still rejects; after 24 h it applies; tightening is immediate); cooling-off after 3 losing trades and after a 5 % daily loss; monthly loss limit.
2. **Most you could lose = preview incl. fees, 20 randomised cases** (`novice-ticket.int.test.ts`, seeded PRNG): random asset, direction, amount and safety net → `/novice/ticket` → assert equality with a direct `/orders/preview` for the returned body, that `total = price + costs` and costs > 0, and that the web formatter shows exactly that value.
3. **e2e flow** (`novice.spec.ts`): sign up → onboarding (5 screens, disclosure with `[XX]%`, acknowledgement, limits) → trade (3 steps, review sheet, checkbox) → the loss reaches the daily limit → cooling-off card and a refused trade → switch to Pro (position in the blotter) and back (position, limits and cooling-off kept).
4. **Mobile Lighthouse + axe**: Lighthouse 13 mobile preset on the production build (`/home`, authenticated): performance ≥ 85, accessibility ≥ 95; Lighthouse 11 PWA installable; axe clean on every novice page at 390 px and 1440 px.
5. **EN/FR complete**: `i18n:check` in CI + vitest; readability report committed.
6. **STATUS** updated.

Full gate before finishing: build, lint, typecheck, test, test:integration (twice), test:e2e, py:check.

## 6. Results

Measured on 2026-09-26 in the goal 08 worktree (own databases `kora_novice_test`, `kora_novice_e2e`; e2e ports 4018/3018/8018/4118).

### 6.1 Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| A novice cannot place an order without a stop | **Pass** | `apps/api/test/novice-guardrails.int.test.ts`: `NOVICE_STOP_REQUIRED` on `/orders`, on a limit order and on the robot path (API level). |
| A novice cannot use leverage | **Pass** | Same file: `NOVICE_LEVERAGE` at 1×; `PUT /novice/leverage` → 403 `knowledge_check_required` without the check; after passing, still pending (refused) for 24 h; after 24 h allowed only up to `KORA_NOVICE_MAX_LEVERAGE`. |
| A novice cannot open the strategy builder | **Pass** | Same file: 403 on `/robots/builder`, `POST /strategies`, `POST /strategies/validate`, `POST /backtests`, `POST /robots`; e2e `rbac.spec.ts` shows the friendly page. Template robots only through `/novice/auto-invest` (B-614, `novice-autoinvest.int.test.ts`). |
| A novice cannot loosen a limit without the 24 h wait | **Pass** | Same file: loosening goes to `pending`, the old limit still rejects; after 24 h (faked app clock) it applies; tightening is immediate; first limit set counts as a tightening. |
| Cooling-off after 3 losing trades / 5 % day loss | **Pass** | Same file (`NOVICE_COOLING_OFF`, closing still allowed) + domain tests `novice.test.ts`, `risk.test.ts`. |
| "Most you could lose" = preview incl. fees, 20 randomised cases | **Pass** | `apps/api/test/novice-ticket.int.test.ts`: seeded PRNG, 20 cases over 10 assets, both directions; `/novice/ticket` total equals a direct `/orders/preview` of the returned body, `total = price + costs`, entry fees > 0, and the web formatter shows exactly that value (`apps/web/src/lib/novice/novice.test.ts`). |
| e2e: onboard → limits → trade → reach limit → cooling-off → Pro and back, state kept | **Pass** | `apps/web/e2e/novice.spec.ts` (plus French, auto-invest and Learn flows). |
| Mobile Lighthouse: PWA installable, perf ≥ 85, a11y ≥ 95; axe clean | **Pass** | Lighthouse 13.5 mobile, production build, authenticated: `/home` perf **0.96**, a11y **1.00**, best practices 0.96 (LCP 2.5 s, TBT 130 ms, CLS 0.038); `/practice` 0.94 / 1.00; `/learn` 0.94 / 1.00. Lighthouse 11.7 (has the PWA category): PWA **1**, `installable-manifest` 1, perf 0.92. Chromium `Page.getInstallabilityErrors` = `[]` (`pwa.spec.ts`). axe clean (serious/critical 0, contrast included) on every novice page at 390 px and 1440 px (`novice-mobile.spec.ts`, `novice.spec.ts`). The last Lighthouse run preceded a CSS specificity-only fix for 44 px segmented buttons; not re-measured (B-805 puts Lighthouse in CI). |
| EN/FR complete (CI check), readability report committed | **Pass** | `fr.ts` typed `Record<MessageKey, string>`; `pnpm --filter @kora/web i18n:check` (CI step) checks keys, variables, glossary links, used keys and knowledge-check copy. `docs/novice/readability-report.md`: EN Flesch–Kincaid grade **2.0** overall, 2.3 on 12+ word strings, max 7.6 (target ≤ 8); FR Kandel–Moles ease 94. |
| STATUS updated | **Pass** | `docs/STATUS.md` G8 row and goal 08 section. |

Other requirements: onboarding 5 screens + versioned disclosure with `[XX]%` from `KORA_DISCLOSURE_RETAIL_LOSS_PCT` + acknowledgement bound to version/hash/values (`novice-onboarding.int.test.ts`); auto-invest templates only, risk 1–5, OOS/paper results only, "past results are not a promise", live refused (`novice-autoinvest.int.test.ts`, `novice.spec.ts`); ~10 global assets from the registry (`novice_rank`), amounts in the account currency; 44 px targets, bottom tab bar, no sideways scroll at 390 px; offline "Prices paused" shell (`sw.test.ts` VM test + cache check); no push/notification prompt (`pwa.spec.ts`); ESLint gamification rule with fixtures; "Explain this to me" slot behind `KORA_EXPLAIN_THIS` (`explain-slot.test.tsx`).

### 6.2 Gate

| Step | Result |
|---|---|
| `pnpm build` | pass |
| `pnpm lint` | pass (incl. `eslint.novice.mjs`) |
| `pnpm typecheck` | pass |
| `pnpm test` | pass: domain 171, ui 113, market-data 60, web 51, api 45, sdk 14, bot-runner 11 |
| `pnpm test:integration` ×2 | 163/163 and 163/163 (second run bypassing the cache) |
| `pnpm test:e2e` | 47/47 |
| `pnpm py:check` | pass: 124 tests, coverage 97.7 % |

Fixed along the way: a race in `kill-switch.spec.ts` (touch hold dispatched before hydration; the kill switch now exposes `data-ready` after mount and the spec waits for it).

### 6.3 Decisions recorded

- **B-614**: guarded `/novice/auto-invest` path (template strategy unchanged, PAPER robot `origin = 'novice_template'`, 1–25 % allocation, 1× exposure, limits from the user's daily limit, live always refused with an audited checklist). ADR 0008 §6.
- **OQ-Q1**: Practice shows the retail-loss line from the same disclosure registry (`[XX]` until OQ-R1). `docs/open-questions.md`.
- New open questions OQ-N1 (guardrail thresholds), OQ-N2 (borrowing cap), OQ-N3 (suggested limits), OQ-N4 (knowledge-check content).

### 6.4 Deferred

B-801 server-side "acknowledged before first order" gate (goal 09) · B-802 Pro simulator scenario UI · B-803 customer time zones for cooling-off/day boundaries · B-804 security/limit alerts · B-805 Lighthouse in CI · B-806 localise remaining shared screens · B-807 scheduled template backtests · B-808 human plain-language copy review sign-off (pack in `docs/novice/copy-review.md`) · B-809 offline-navigation e2e · B-810 risk-officer view of guardrail events.
