# Novice copy review pack (B-504, B-614)

Prepared in goal 08 for the human plain-language review by **S1** (product design) and **S8** (risk and
compliance), in English and French. Nothing in this pack replaces that review; it lists what to read,
what the machines already check, and what needs a human decision.

## Where the copy lives

| Area | Source | Keys / content |
|---|---|---|
| All Novice screens (EN, source of truth) | `apps/web/src/lib/i18n/en.ts` | `shell.*`, `home.*`, `trade.*`, `review.*`, `limits.*`, `borrow.*`, `cool.*`, `onb.*`, `ai.*`, `learn.*`, `lesson.*`, `term.*`, `practice.*`, `settings.*`, `offline.*`, `risk.*` |
| All Novice screens (FR) | `apps/web/src/lib/i18n/fr.ts` | same keys |
| Regulatory risk warning (EN, FR), versioned | `apps/api/src/disclosures/risk-warning.v1.json` | banner, 6 paragraphs, acknowledgement statement; `{retailLossPct}` from `KORA_DISCLOSURE_RETAIL_LOSS_PCT` |
| Knowledge check (graded EN text; FR overlay in `fr.ts` under `kc.q.*`) | `apps/api/src/appropriateness/questionnaires/knowledge-check.v1.json` | 5 questions, pass mark 80 % |
| Ready-made robot names, summaries, risk reasons (B-614) | `en.ts`/`fr.ts` `ai.t.*`, `ai.factor.*`; rule in `packages/domain/src/novice/templates.ts` | Steady Trend (2/5), Gold Balance (3/5), Crypto Breakout (5/5) |
| Curated instrument names (EN, FR) | registry `instruments.novice_name` (migration 0080) | 10 names |
| Server risk messages (English, shown in Pro and logs) | `packages/domain/src/trading/risk.ts` | Novice screens show the plain `risk.<CODE>` copy instead |

## Already checked automatically (CI)

- EN and FR have the same keys, no empty strings, the same `{variables}` and the same glossary links
  (`pnpm --filter @kora/web i18n:check`).
- Every key used in Novice code exists; key families (risk codes, robots, lessons, practice options)
  are complete; the EN knowledge-check copy equals the graded data file.
- Readability: English corpus Flesch–Kincaid grade ≤ 8, and every string of 12+ words ≤ 8
  (`docs/novice/readability-report.md`). French is scored with Kandel–Moles for information.
- Practice screen: no Pro jargon outside glossary links (`practice.spec.ts`).
- No confetti, streaks or leaderboards in Novice files (ESLint rule, `eslint.novice.mjs`).

## Please decide or check by hand

1. **Tone and truthfulness** of the numbers' wording: "Most you could lose" (it can be exceeded when a
   price gaps past the safety net; the copy says so next to it and in the review sheet).
2. **Gain scenario** in the review sheet ("If it moves the same amount your way, you gain about …"):
   is a symmetric scenario acceptable next to the loss, or should only the loss be shown? (S8)
3. **Cooling-off wording** (`cool.*`, `risk.NOVICE_COOLING_OFF`): calm, not shaming.
4. **Borrowing** copy (`borrow.*`, `onb.s4.*`, `lesson.borrowing.*`) against OQ-R3 once leverage caps
   are known; the 2× cap is a placeholder.
5. **Risk levels 1–5** for the ready-made robots: accept the documented rule or override per template.
6. **Risk warning** text and the acknowledgement statement (legal wording, per jurisdiction: OQ-R1/R2);
   publishing a new version makes everyone acknowledge again.
7. **Knowledge-check questions** (OQ-C1): content, answer key, pass mark, cool-down, French wording.
8. **French**: register (vous), finance terms ("écart" for spread, "filet de sécurité" for stop,
   "effet de levier"), typography (narrow no-break spaces before `%`, `:`; typographic apostrophes).
9. **Practice (OQ-Q1)**: the skill-free assumptions and the retail-loss line shown next to the result.

## Sign-off

| Reviewer | Language | Date | Result | Notes |
|---|---|---|---|---|
| S1 (product design) | EN | | | |
| S1 (product design) | FR | | | |
| S8 (risk and compliance) | EN | | | |
| S8 (risk and compliance) | FR | | | |
