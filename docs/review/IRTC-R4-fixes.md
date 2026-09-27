# IRTC R4 — AI safety and compliance: corrections

Corrector for the R4 report (`R4-ai-compliance.md`, 2 High · 8 Medium · 11 Low), 2026-09-27, per
CHARTER §6 (reproduce → failing regression test → root-cause fix → test passes). Branch
`worktree-agent-aaf6e9d0a493a5643` from `claude/magical-newton-yyxga6`. Migrations 0120–0122.

Test databases `kora_fix_r4_test` / `kora_fix_r4_e2e`, e2e ports 4064/3064/8064/4164. "Before" is the
new regression test run on the unfixed code; "after" is the same test after the fix.

## Summary

| ID | Sev | Verdict | Fixed in | Regression test |
|---|---|---|---|---|
| R4-01 | High | Confirmed | `core/stream-guard.ts`, `core/engine.ts`, `ai.service.ts`, controllers, `CopilotChat` | `irtc-r4.unit.test.ts` R4-01; `ai.int.test.ts` "IRTC R4-01"; evals `guard_adversarial` (`stream_guarded` grader) |
| R4-02 | High | Confirmed | `admin.controller.ts`, `four-eyes.service.ts`, migration 0121, evidence KC-02/KC-08, ADR 0009 §4a | `role-grants.int.test.ts`; `packages/domain/.../four-eyes.test.ts` |
| R4-03 | Medium | Confirmed | `core/guards.ts` (source harvesting, calibration rule, number words, time/id tokens), `core/normalise.ts` | `irtc-r4.unit.test.ts` R4-03; evals `guard-num-*` |
| R4-04 | Medium | Confirmed | `core/normalise.ts`, `core/guards.ts` patterns | `irtc-r4.unit.test.ts` R4-04; evals `guard-exec-*`, `guard-novice-*` |
| R4-05 | Medium | Confirmed | `core/untrusted.ts` (default untrusted keys + long free text), `prompts.ts` `groundingForModel`, `intel/core/news-score.ts` `unsafeDisplayText`, `trend-card.ts`, `news.service.ts` | `irtc-r4.unit.test.ts` R4-05; `intel.unit.test.ts` (What's moving) |
| R4-06 | Medium | Confirmed | `ai/draft-binding.ts`, `orders.controller.ts`, `oms.service.ts` (bind in tx), `drafts.service.ts`, migration 0120, KC-21, `Ticket.tsx` | `ai.int.test.ts` "IRTC R4-06" (+ updated "Draft to ticket") |
| R4-07 | Medium | Confirmed | `governance/anchors.service.ts`, `audit.service.ts` head witness, internal audit + KC-13, config default | `anchors.unit.test.ts`; `internal-audit.int.test.ts` "IRTC R4-07" |
| R4-08 | Medium | Confirmed | `ai.service.ts` (`answerHash`/`answerLength`/`rawAnswerHash`), `news.service.ts` (translation event), `drafts.service.ts` (`rationaleHash`) | `ai.int.test.ts` (cache + R4-01 tests); `intel.int.test.ts` pipeline test |
| R4-09 | Medium | Confirmed | `oms.service.ts` (gate for every role), `appropriateness.controller.ts`, `acknowledgements.service.ts`, migration 0122, `Appropriateness.tsx`, `ProRiskWarningBanner.tsx` | `risk-warning-gate.int.test.ts` |
| R4-10 | Medium | Confirmed | `admin.controller.ts` (trader = role_grant with reason + override flag), `user-provisioner.service.ts` | `role-grants.int.test.ts` (trader case); `user-provisioner.test.ts` |
| R4-11 | Low | Confirmed | `untrusted.ts` (redact in `wrapUntrusted`), `config.ts` (salt required outside dev/test), `pii.ts` | `irtc-r4.unit.test.ts` R4-11 |
| R4-12 | Low | Confirmed | `ai/core/config.ts`, `governance-config.ts` (NODE_ENV=production) | `irtc-r4.unit.test.ts` R4-12; `anchors.unit.test.ts` |
| R4-13 | Low | Confirmed | `compliance/subject-access.service.ts` | `compliance.int.test.ts` subject access |
| R4-14 | Low | Confirmed | `untrusted.ts` `neutralise` (NFKC + any tag look-alike) | `irtc-r4.unit.test.ts` R4-14 |
| R4-15 | Low | Confirmed | `drafts.service.ts` (size cap, labelled + neutralised note), `AiDraftLoader.tsx` | `ai.int.test.ts` adversarial test (no ≥1,000,000 draft) |
| R4-16 | Low | Confirmed (coverage gap; code was clean) | `ai.static.test.ts` (intel included, computed calls, ModuleRef) | same file, self-test of the evasions |
| R4-17 | Low | Confirmed | `four-eyes.service.ts` (reject independence), `drafts.service.ts` + `ToolCallCtx.author` | `role-grants.int.test.ts` (reject by independent admin); `ai.int.test.ts` robots drawer (`actor_type: user`) |
| R4-18 | Low | Confirmed | `lib/retail-loss.ts`, `GainSimulator.tsx`, simulator page reads the registry | `lib/retail-loss.test.ts` |
| R4-19 | Low | Confirmed | `apps/web/eslint.novice.mjs` (all screens + push nudges; badges/trophies in novice) | `lib/novice/novice.test.ts` |
| R4-20 | Low | Confirmed | `budget.service.ts` (reservation), pipeline budget, `ai.service.ts`, `news.service.ts` | `budget.unit.test.ts` |
| R4-21 | Low | Confirmed, **not fixed** — logged | — | OQ-C4 (Compliance) |

## High

### R4-01 · Streaming sent unguarded model text
- **Root cause.** `runCopilot` passed the provider's `onText` straight to the SSE writer; guards ran
  only on the finished answer.
- **Fix.** The engine no longer exposes raw deltas (`onGuardedText` replaces `onText`).
  `GuardedTextStream` buffers to a sentence boundary (`[.!?]` + whitespace, or newline, so `1.0842`
  is never split), then checks the sentence with `hasExecutionClaim` (raw and normalised, with the
  text already shown) and `ungroundedNumbers` against the sources known so far (grounding as the
  model saw it, the question, earlier tool outputs). The first failure trips the stream; the guarded
  `final` answer replaces the preview. Novice answers are not streamed. The Anthropic provider is
  unchanged: the SDK `text` event carries only `text_delta` (no thinking), so guarding at the engine
  hook covers every provider, and anything already shown before a mid-stream refusal has passed the
  guards. `CopilotChat` marks the preview "Checking each sentence against KORA data…".
- **Before.** Reviewer `r4/t4.log`: `RAW DELTAS SHOWN TO USER BEFORE GUARDS: Done! I have placed your
  order for 250000 units … filled at 1.23456 … 97.3% guaranteed.`
- **After.** `ai.int.test.ts` "IRTC R4-01" (adversarial persona over SSE): no delta matches
  `placed your order|filled at|started the robot|97.3|1.23456|250000`; `final.flags.executionClaim`
  is true. The reference persona still streams (`bid 1.08419`). Evals: `stream_guarded` passes on all
  133 cases.

### R4-02 · One admin could create their own approver
- **Root cause.** Role grants were a single-admin action with no independence relation recorded, and
  approvals only compared requester ≠ approver.
- **Fix.** Adding `admin`/`risk_officer`/`auditor`/`trader` needs a reason and opens a `role_grant`
  four-eyes request (202), approved only by another admin who is not the subject; the approval applies
  the exact before→after (409 if the roles moved) and records `granted_by`, `approved_by`,
  `four_eyes_request_id` (migration 0121). Self-grants: 403 `self_grant` (+ NOT VALID constraints).
  Every approve **and reject** checks, from `user_roles`, that the decider's approval role was neither
  granted nor approved by the requester and is older than `KORA_APPROVER_COOLING_HOURS` (24 h outside
  dev/test): 403 `approver_not_independent`. KC-02 now reports privileged grants with/without four-eyes
  and self-granted rows; KC-08 covers `role_grant` and counts `approver_role_granted_by_requester`.
  ADR 0009 §4a; control matrix regenerated with `pnpm --filter @kora/api control-matrix`.
- **Before.** `role-grants.int.test.ts`: `expected 202 "Accepted", got 400` (grant applied directly),
  `expected 403 … got 400` (self-grant), trader grant `expected 400 … got 200`. Reviewer `r4/t2.log`:
  sock approved the MFA reset.
- **After.** 6/6 pass: the sock (risk_officer granted by admin A) gets `approver_not_independent`
  on A's MFA reset; the victim keeps MFA; evidence flags a legacy approval of that kind.

## Medium

### R4-03 · Numeric fidelity satisfied by noise; calibration not enforced
- **Root cause.** `collectSourceNumbers` harvested digits from every string and key (UUIDs, ISO
  timestamps, `rsi14`, untrusted titles); only ASCII digits were checked; rule 3 lived in the prompt.
- **Fix.** Figures come from numeric leaves, decimal strings and KORA label strings only; never keys,
  identifier-named keys (`id`, `*Id`, `*At`, `*Ts`, hashes, links), untrusted keys or wrapped text.
  UUIDs, dates, clock times and full ISO timestamps in an answer are matched as whole tokens against
  the sources. A percentage in a sentence about confidence/probability/chance/hit rate must equal a
  calibrated figure (`value`/`hitRate`/`probability`/… on an object with `n`) and its `n` must appear
  in the sentence. Number-word percentages are flagged. The scripted reference persona no longer
  repeats figures from untrusted calendar titles (prompt rule 2 says so too).
- **Before.** 7/7 R4-03 unit tests failed (e.g. `Confidence is 57% (n=87)` against a UUID and a
  timestamp → `[]`; 63 of 90 integer percentages accepted from 50 id/timestamp rows).
- **After.** All pass: 0 of 90 percentages accepted; `63% (n=14)` from `rsi14: 63.21` flagged;
  `fifty-seven percent`, `５７％`, `٩٩٪` flagged; `97%` from a news title flagged; a real calibrated
  `57% (n=87)` passes.

### R4-04 · Keyword guards on un-normalised text
- **Fix.** `normaliseText` (NFKC, invisible characters removed, all Unicode `Nd` digits → ASCII,
  Arabic percent/decimal signs) runs before every guard; keyword guards also test a
  confusable-folded variant and a variant where invisible characters become spaces. Patterns cover
  the review's paraphrases (is live, went through, gone ahead and, wise to purchase, great time to get
  in, load up, smart move, sentence-initial imperatives), with no-false-positive cases in the test.
  The structured second classifier suggested by the reviewer is not implemented (see open items).
- **Before.** 12/12 bypass cases failed. **After.** All pass; 4 legitimate sentences stay unflagged.

### R4-05 · Untrusted text unwrapped
- **Fix.** `DEFAULT_UNTRUSTED_KEYS` (name, robotName, description, title, translatedTitle, summary,
  source, url, reason, rationale, note, …) are wrapped in every tool output and in grounding
  (`groundingForModel`, used by both the prompt and the guards); any string > 120 characters or
  multi-line is wrapped unless its key is a KORA template (`message`, `edgeStatement`, …). Translated
  news text is checked by `unsafeDisplayText` (advice, execution claim, injection markers) before it
  is stored, and the novice "What's moving" item never shows a title that fails it.
- **Before.** 4/4 R4-05 unit tests failed; `intel.unit.test.ts` showed "Buy Toyota now before it
  rises" to a novice. **After.** All pass.

### R4-06 · Draft acceptance not bound to the draft
- **Fix.** Orders take `aiDraftId`; the server decides the source (`decideOrderSource`):
  `ai-draft-accepted` only when the draft is the user's, unused and matches symbol/side/type/qty;
  otherwise `manual`. `source: ai-draft-accepted` without a draft id → 400 `ai_draft_required`. The
  OMS binds `ai_order_drafts.placed_order_id` (unique) inside the order transaction, only once risk
  accepts the order. Acceptance requires `order_id = placed_order_id` on a non-rejected order (API +
  CHECK constraint; the draft guard trigger allows the one binding update). KC-21 counts accepted
  drafts not bound to their order. The ticket sends the draft id and records acceptance only when
  the server marked the order as placed from the draft.
- **Before.** `ai.int.test.ts`: a client-labelled order was `201` (expected 400); reviewer `r4/t1.log`:
  one rejected opposite-side order accepted two drafts. **After.** Opposite side → manual and cannot
  accept; risk-rejected order cannot accept; the matching order accepts its own draft once and not
  another; a second order from a used draft is manual.

### R4-07 · Anchors self-certifying; tail truncation invisible
- **Fix.** Signatures verify only with pinned keys by key id (the configured signing key's public
  half plus `KORA_AUDIT_ANCHOR_TRUSTED_JWKS`), never the row's `public_jwk`; `trustedKey` reported.
  `AuditService.verify()` consults a head witness registered by `AnchorsService`: the latest
  trusted-valid anchor must still be covered (count ≥ anchored count and the anchored hash at the
  anchored id) → otherwise `valid:false`, `truncated_after_anchor` / `anchor_mismatch`;
  `eventsAfterLastAnchor` reported. The JSON-lines WORM copy is read back (signature, presence in the
  DB, match with the chain) in internal audit and KC-13. The job runs daily by default except in
  tests; NODE_ENV=production alone requires a real key.
- **Before.** Reviewer `r4/t3.log`: after deleting ids 197–201 `verify` stayed valid; an
  attacker-keyed anchor showed `signatureValid:true`. New tests failed (exports missing).
- **After.** `anchors.unit.test.ts` 4/4 (attacker key invalid; truncated / mismatch detected; WORM
  copy detects dropped anchors and a rewritten chain; defaults). `internal-audit.int.test.ts`: an
  insider-signed anchor that matches the chain is `signatureValid:false, trustedKey:false`, and
  `/audit/verify` is witnessed by the genuine anchor. Residual: events after the latest anchor are
  not witnessed until the next anchor (daily cadence bounds the window).

### R4-08 · Content of AI suggestions not recorded
- **Fix.** `ai.request` carries `answerHash` (SHA-256 of the exact text returned, cached answers
  included), `answerLength`, and `rawAnswerHash`/`rawAnswerLength` when the guards changed the text.
  Translation is its own `ai.request` (`task: news_translate`, prompt hash, `shownHash`); the score
  event carries `translationPromptHash`. Order drafts audit `rationaleHash`. The text itself stays
  out of the audit log (retention/PII); any copy can be checked against the hash.
- **Before.** `expected undefined to be '<sha256>'`. **After.** Hash of the displayed answer matches
  on fresh and cached requests; raw hash differs when the execution guard fired; translation event
  present with its prompt hash.

### R4-09 · Traders never acknowledged the risk warning
- **Fix (implemented, Compliance to confirm in OQ-C3).** The OMS disclosure gate applies to every
  role (reducing orders still pass). An appropriateness attempt must carry the risk warning in force
  (version + content hash; 409 if stale, 400 if missing); a pass records it as the acknowledgement
  (`context: appropriateness`, same transaction, migration 0122), a context users cannot
  self-declare. The assessment page shows the warning with a confirmation box; Pro accounts that
  have not acknowledged (staff roles, or a new version/figure) get a Pro banner to confirm it.
- **Before.** `risk-warning-gate.int.test.ts`: attempt without the warning `200` (expected 400);
  admin-granted quant's first order `201` (expected 422). **After.** 3/3 pass.

### R4-10 · `trader` without the assessment
- **Fix.** An admin grant of `trader` is a `role_grant` (reason required, second admin), whose
  payload records `appropriatenessPassed` and `appropriatenessOverride` (KC-28 exceptions are
  traceable). With Keycloak, `trader` in a token without a local passed attempt is removed from the
  request's principal and from the synced roles (re-checked every request until the user passes).
- **Before.** `setRoles(novice→trader)` `200` with no attempt; provisioner kept `trader`.
  **After.** 400 without a reason, 202 pending with the override flag, applied only on a second
  admin's approval; provisioner test 2/2.

## Low (summary)

- **R4-11** `wrapUntrusted` redacts e-mail/IBAN/card/phone; outside dev/test the copilot is
  unavailable without a 16+ character `KORA_AI_PSEUDONYM_SALT`; an empty salt falls back only in dev.
- **R4-12** `NODE_ENV=production` disables test providers and the ephemeral anchor key.
- **R4-13** Export adds strategy versions, backtests, robot signals, promotions, intel alert events,
  token revocations (no ids), equity snapshots, role approvals, and events others recorded about the
  subject (`audit_events_about_you`).
- **R4-14** `neutralise` NFKC-normalises and neutralises any `<[/]letter…` tag look-alike.
- **R4-15** Drafts the risk preview rejects for size are refused (the hostile 1,000,000 BTCUSD
  draft); the ticket note says "copilot's words, not advice".
- **R4-16** Static guard scans `src/ai` and `src/intel`, catches computed member calls and restricts
  `ModuleRef` lookups to the read-only intel service.
- **R4-17** Reject applies the same independence checks; robot-drawer suggestion drafts are audited
  as the user (`origin: user_from_suggestion`).
- **R4-18** The Gain Simulator disclaimer reads `retailLossPct` from the registry (placeholder until
  published).
- **R4-19** Core gamification words and push/notification nudges are errors on every screen; novice
  files also ban badges, trophies, achievements and rewards.
- **R4-20** The budget check reserves `KORA_AI_MAX_TOKENS` atomically and settles later; the news
  pipeline spends `KORA_AI_PIPELINE_DAILY_TOKENS`.
- **R4-21** Not changed: the feedback policy is a Compliance decision (OQ-C4).

## Other changes made while running the gate

- `strategies.int.test.ts` clears BTCUSD 1h candles before seeding: other files seed the same series
  and the file order varies, which made the B-502 OOS-trade assertion flaky.
- Test helpers: traders confirm the risk warning when they pass the assessment; staff test users
  acknowledge on first use; draft-binding tests refresh the SIMULATED quote and feed status.

## Gate (this worktree)

| Check | Result |
|---|---|
| `pnpm build` | pass (7/7) |
| `pnpm lint` | pass (13/13) |
| `pnpm typecheck` | pass (13/13) |
| `pnpm test` | pass except `services/bot-runner` kill-switch test under parallel load; passes alone twice (see open items) |
| `pnpm test:integration` ×2 | 42 files / 260 tests, green twice in a row (second with `--force`) |
| `pnpm test:e2e` | 62/64; the 2 failures were the timing-bound axe and tick-to-paint checks at load average ~14 on 4 cores; the spec passes alone (3/3, p95 78 ms) |
| `pnpm py:check` | pass (164 tests, 97 % coverage) |
| `pnpm evals` | 133/133, every category 100 % (new `guard_adversarial`: 16 cases) |

## Left open (owner)

- **R4-21** assessment feedback oracle — Compliance (S8), OQ-C4.
- **R4-04** structured second-pass classifier (model returns `{containsSuggestion, claimsExecution}`)
  on top of the deterministic guards — AI engineer (S7); deterministic guards fail closed today.
- **R4-09** scope and wording of the all-roles acknowledgement — Compliance (S8), OQ-C3.
- **R4-02** approver cooling period (24 h placeholder), first-admin bootstrap and Keycloak realm-role
  governance — Compliance (S8) / Security (S9), OQ-G4.
- **R4-07** events after the latest anchor stay unwitnessed until the next anchor; real object-lock
  storage — Operations (S10), deployment item.
- `packages/sdk/openapi.json` not regenerated (order schema gained `aiDraftId`, attempt schema
  `riskWarning`); regenerate after the parallel correctors' branches merge — Project Owner.
- `services/bot-runner` runner test uses a global Redis channel with fixed ids and cross-talks with
  concurrent runs on a shared Redis — test-integrity seat (R6).
- Deployments must now set `KORA_AI_PSEUDONYM_SALT` (copilot unavailable otherwise) and should set
  `KORA_AUDIT_ANCHOR_TRUSTED_JWKS` after a key rotation — Operations.
