# ADR 0008 — Novice view: server-side guardrails, server-built ticket, disclosures interface, i18n, PWA

- Status: Accepted (2026-09-26)
- Deciders: S1 (principal product designer, lead), S6 (frontend engineer), S8 (risk and compliance), S3, S9, S10, Project Owner
- Context: goal 08; STATUS hand-overs from goal 03 (questionnaire engine, preview contract, `NOVICE_*` risk rules), goal 04 (helpers), goal 05 (Practice), goal 06 (templates API, B-614); master goal scope amendment (global markets); prototype `design/prototype/Novice.png`.
- Related: [plan 08](../plans/08-novice-view.md), [copy review pack](../novice/copy-review.md), [readability report](../novice/readability-report.md).

## Decisions

### 1. One engine, one flag, rules in the risk path

Every Novice guardrail hangs off the goal 03 flag `OmsService.isNovice` (novice-only users and anyone
in the Novice view) and lives in the pure `evaluateRisk`: market + stop only, no borrowing
(`noviceMaxLeverage`, default 1×), cooling-off (`NOVICE_COOLING_OFF`), and the new optional monthly
limit (`MONTHLY_LOSS_LIMIT`). The web never decides; it shows the server's verdict (preview
`risk.violations`, 422 on placement) in plain, localised words keyed by risk code. Robot orders of
novice template robots take the same path.

### 2. Loosening waits, tightening is immediate — without a scheduler

Pending loosenings are stored next to the limits (`accounts.risk_limits.pending[field] = {value,
requestedAt, effectiveAt}`) and `AccountsService.limits(account, now)` applies one once its time has
come. Every process computes the same answer, there is no job to miss, and tests use a faked clock.
The rule applies to guarded users only; Pro loosening policy is OQ-R5 / goal 09. Setting a limit
where none was in force is a tightening. Borrowing uses the same mechanism (`noviceMaxLeverage`
raised = loosening), gated by a passed knowledge check.

### 3. Cooling-off is computed, not stored

`coolingOff()` derives the state from today's closing fills (net of fees) and the day's P&L versus the
day-start snapshot: 3 losing trades, a 5 % day loss, or the daily limit → no new exposure until the
next UTC day; closing always works. No table, no drift; the customer's time zone is B-308/B-803.

### 4. The server builds the Novice ticket

`POST /novice/ticket` turns "amount in the account currency + safety net %" into a registry-valid
market order (quantity rounded down on `qtyStep`, stop rounded away from the entry on the tick grid,
FX from the paper engine's rates) and returns the **unchanged** `/orders/preview` answer for it. The
UI shows `lossIfStopHit.total` (price loss + fees) and places exactly the returned body. There is no
second loss calculation to drift; a 20-case randomised test proves equality with a direct preview.

### 5. Disclosures behind an interface goal 09 can replace

`DISCLOSURE_REGISTRY` (`current(id, locale)`) and `DisclosureAcknowledgements` are the only things
callers use. Goal 08 ships a config-backed registry (versioned JSON in EN and FR, the retail-loss
figure from `KORA_DISCLOSURE_RETAIL_LOSS_PCT`, placeholder `[XX]` until OQ-R1). An acknowledgement is
bound to version + content hash + rendered values; a new figure or version means everyone
acknowledges again. Acknowledgements are append-only and audited.

### 6. B-614: a guarded Novice path for template robots

Novices do not get the builder API. `/novice/auto-invest` creates a strategy from a goal 06 template
unchanged and a PAPER robot with `origin = 'novice_template'`, an allocation capped at 25 % of the
balance, 1× gross exposure and loss limits derived from the user's own daily limit. The bot runner
accepts a novice owner only for that origin. Results shown are OOS test results (by content hash)
and the user's own paper results, never in-sample. Going live is always refused (audited checklist:
knowledge check, goal 06 promotion rules, `LIVE_TRADING_ENABLED`). Risk levels 1–5 follow a
documented rule (`templateRiskLevel`).

### 7. Own tiny i18n layer

`en.ts` is the source of truth and `fr.ts` is typed as `Record<MessageKey, string>`, so a missing key
fails the typecheck; `i18n:check` (CI) also compares variables and glossary links, verifies every key
used in Novice code and the dynamic key families, and pins the knowledge-check copy to the graded
data. Markup is minimal (`[text](term:id)`, `**bold**`). Locale: cookie, then `Accept-Language`;
Pro screens stay English. No dependency was added. Money is formatted from decimal strings (EN
`$10,482.30`, FR `10 482,30 $`); dates render after hydration only (server ICU ≠ browser ICU).

### 8. PWA: offline shell only, no push

`app/manifest.ts` + `public/sw.js`: network-first navigations with a cached `/offline` "Prices paused"
page, cache-first hashed assets, `/api` never cached, and no `push`/`notificationclick` handler.
CSP gains `worker-src 'self'` and `manifest-src 'self'`. Performance: server-rendered home data, SVG
chart, the Pro shell loaded with `next/dynamic`, and metric-matched font fallbacks (Figtree/Arial,
Fraunces/Times) so the web-font swap does not shift the layout.

### 9. No gamification, enforced

ESLint (`eslint.novice.mjs`) rejects imports, dynamic imports, calls and JSX elements named
confetti/streak/leaderboard in Novice files; a unit test runs ESLint on fixtures.

### 10. "Explain this to me" is a typed slot

`registerExplainThis(Component)` + `<ExplainThis topic context />` with `ExplainSlotProps {topic,
context (strings only), locale, mode: 'novice'}`, hidden unless `KORA_EXPLAIN_THIS=on` and a component
is registered. No copilot code in goal 08.

## Consequences

- Guardrail changes are data (env placeholders, OQ-N1/N2) and pure-function tests, not UI work.
- Goal 09 swaps the disclosure registry, adds the server-side "acknowledged before first order" gate
  (B-801), customer time zones (B-803) and suitability on the same questionnaire engine.
- Trade-offs: a trader who switches to Pro may loosen limits immediately (by design: guardrails follow
  the view, as in goal 03); cooling-off lasts until the next UTC day; Playwright cannot fail a service
  worker's own fetches, so the offline fallback is tested in a VM plus a cache check (B-809).
