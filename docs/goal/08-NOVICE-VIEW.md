# /goal 08 — Novice view (desktop + mobile PWA)

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, `/design/prototype/Novice.dc.html` and `NoviceMobile.dc.html`.

## Goal
Deliver a calm, plain-language experience for non-experts on the same account and engine. Every screen answers "what could I lose?" before anything happens, and protective limits are on by default.

## Scope
1. **Onboarding:**
   - a 5-screen explainer (what trading is, spread and fees, stop / safety net, leverage, losses are normal);
   - a practice-money account created automatically;
   - the regulatory disclosure is shown and acknowledged, with `[XX]%` pulled from config set by Compliance;
   - the user sets their daily and monthly loss limits, with suggested defaults.
2. **Home:** account value (Fraunces headline), change since start, simple area chart, "worst dip so far", holdings described in words ("You gain if the euro rises").
3. **Make a trade (3 steps):**
   - pick asset (curated list of about 10);
   - direction in words ("It will go up / go down");
   - amount in currency;
   - safety-net slider (a stop is required);
   - "Most you could lose" and fees in currency, both from `/orders/preview`;
   - a review sheet with a gain/loss scenario and a required "I understand I could lose up to $X" checkbox;
   - confirm.
4. **Guardrails, enforced server-side by goal 03 risk rules for role `novice`:**
   - leverage off;
   - loss limits: tightening takes effect immediately, loosening waits 24 h;
   - a cooling-off prompt after 3 losing trades in a day or a 5% daily loss;
   - knowledge checks (5 questions, pass mark 4/5) are needed to unlock leverage or robots in live mode.
5. **Practice:** the goal 05 simplified simulator (good / typical / bad year).
6. **Auto-invest:** robot **templates only** (from goal 06) with a risk level 1–5, plain description, and results only as OOS / paper with the "past results are not a promise" line. Practice first; live requires the knowledge check plus the goal 06 promotion rules.
7. **Learn:** a glossary with inline links from any jargon, 2-minute lessons, and the copilot "Explain this to me" (goal 07, novice mode).
8. **Mobile PWA:**
   - 390 px-first layouts, bottom tab bar, 44 px touch targets;
   - installable, offline shell with a clear "prices paused" state;
   - no push notifications that encourage trading (only security and limit alerts).
9. **Language:** copy lives in i18n files with EN and FR from day one. Readability is at most grade 8. No confetti, streaks or leaderboards (an automated lint forbids those components in novice routes).

## Acceptance criteria
- [ ] A novice cannot:
  - place an order without a stop;
  - use leverage;
  - open the strategy builder;
  - loosen a limit without the 24 h wait.

  Each is an API-level test, not only UI.
- [ ] The "Most you could lose" value equals the preview API value, including fees, for 20 randomised cases.
- [ ] The e2e flow onboards → sets limits → makes a trade → reaches the limit → sees the cooling-off → switches to Pro and back with state kept.
- [ ] Mobile Lighthouse: PWA installable, performance ≥ 85, accessibility ≥ 95. The axe scan is clean.
- [ ] The EN/FR copy is complete (no missing keys, CI check), and the readability report is committed.
- [ ] The STATUS update is done.
