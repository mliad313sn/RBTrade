# ADR 0007 — AI copilot: gateway, tools, calibration, safety, evals

Status: Accepted (goal 07, 2026-09-26). Lead seats S7 (AI), S9 (security), S8 (compliance).
Related: ADR 0102 (audit hash chain), ADR 0004 (AI strip slot, ticket prefill), ADR 0006 (signal
feature store, strategy versions). Goal 07B reuses everything below.

## Context

Goal 07 adds a copilot powered by the Anthropic Claude API that explains signals and results, spots
risk and drafts orders or strategy changes a human must approve. The master goal's non-negotiables
apply: the AI suggests and never executes; every number traces to a source; confidence only when
calibrated; untrusted text is data; every AI action is audit-logged; the model id is never
hard-coded. There is no API key in the build environment, so CI must be deterministic.

## Decision

### 1. Gateway (`apps/api/src/ai`)

- **Official SDK only** (`@anthropic-ai/sdk`) in `providers/anthropic.provider.ts`: streaming
  (`messages.stream` + `finalMessage()`), the stable system prompt and the tool list marked
  `cache_control` (prompt caching), strict tools, adaptive thinking by default (`KORA_AI_THINKING`),
  effort only when `KORA_AI_EFFORT` is set, typed SDK errors mapped to plain messages. The model id
  comes **only** from `KORA_AI_MODEL`; there is no default. Unset model or key → every copilot
  answer is `{status: 'unavailable', message: 'Copilot unavailable …'}` (fail closed, HTTP 200).
- **Provider abstraction** (`AiProvider.complete(request, onTextDelta)` over SDK types): `anthropic`,
  `scripted` (deterministic reference policy + an `adversarial` persona), `replay` (cassettes keyed
  by the full request hash, recorded from live runs with `KORA_AI_RECORD_DIR`). `scripted` and
  `replay` are refused outside `KORA_ENV=dev|test`.
- **Framework-free core** (`ai/core`): prompts, untrusted wrapping, PII minimiser, tool catalogue and
  dispatcher, guards, calibration maths, bias rule, conversation engine. The Nest module injects a
  DB-backed `ToolBackend`; `services/ai-evals` injects SIMULATED fixtures. Same code path.
- **Surfaces**: `POST /ai/chat` (JSON or SSE `delta`/`tool`/`final`, focused-panel context),
  `POST /ai/explain` (novice), `GET /ai/strip` + `POST /ai/strip/draft`, `POST /ai/signals/:id/why`,
  `GET /ai/robots/:id/insights`, `POST /ai/robots/:id/suggestions/draft`, `GET /ai/scan/no-edge`,
  `GET /ai/calibration`, `POST /ai/calibration/strategies/:id/rebuild`, `GET|POST /ai/drafts/:id[/decision]`,
  `GET /ai/status`, `GET /metrics`. The web `/api` proxy passes `text/event-stream` through unbuffered.

### 2. Tools: read-only plus draft-only, enforced on the server

`get_quote, get_candles, get_indicators, get_positions, get_account_risk, get_order_preview,
get_calendar, get_strategy, get_backtest_results, get_bot_signals, get_signal_features,
get_mc_projection, get_calibration` and `create_order_draft, create_strategy_draft`. Inputs are
strict zod schemas; the JSON schema sent to the model is derived from them (`strict: true`, with
constraints strict mode cannot express moved into the description). The dispatcher re-validates
every call, refuses names outside the catalogue (`refused_unknown`), roles that do not allow the tool
(`refused_role`) and pro tools in novice mode (`refused_mode`), and runs each tool **as the user**
(same visibility rules as REST).

**No execution path exists.** The module never imports order-mutation, robot-control or
version-saving services: `read-ports.ts` is the only file that touches `OmsService`,
`RobotsService`, `StrategiesService`, `BacktestsService`, and it exposes only `preview`, `list`,
`detail`, `signals`, `signalFeatures`, `get`, `validate`, `latestBacktest`. `ai.static.test.ts`
fails the build if any copilot file calls `submit/amend/cancel/start/pause/promote/newVersion/…` or
imports those services elsewhere. The integration test runs an adversarial model that calls every
tool with hostile inputs plus 13 forbidden operation names across several prompts and injections,
and asserts orders, robots, strategy versions and the halt flag are unchanged.

**Drafts**: `create_order_draft` writes `ai_order_drafts` and returns a goal 04 `TicketDraft`
(`origin: 'ai'`, `aiDraftId`). Only a user click opens the ticket; the order then goes through the
normal preview and confirmation with `source: 'ai-draft-accepted'`, and the ticket records
`POST /ai/drafts/:id/decision {accepted, orderId}` (the order must be the user's, from that draft).
`create_strategy_draft` applies parameter changes to the current version, validates with
`StrategiesService.validate` (the code behind `POST /strategies/validate`) and stores an unapproved
`ai_strategy_drafts` row; only the user saves a version (`POST /strategies/:id/versions`), and the
acceptance links that human-authored version. Draft rows are append-only and decided once (trigger).

### 3. Calibration table (reused by 07B)

`ai_predictions` logs each prediction (model key, subject, probability, outcome, **net-of-cost**
result, source, timestamps) and `ai_calibration_bins` holds 10 reliability bins. Model keys today:
`strategy:<id>` (OOS trades of the latest backtest: raw score = mean entry-condition contribution
mapped to 0…1, outcome = net P&L > 0) and `bias:<symbol>:<tf>` (the strip's transparent bias rule
replayed over SIMULATED history, outcome = move in the bias direction beyond the spread within 4
bars). The confidence shown anywhere is the observed hit rate of the bin that contains the current
raw score, only if that bin has `n ≥ KORA_AI_CALIBRATION_MIN_N` (30); the reliability line reads
"When we said 0.6, it worked 57% of the time (n=212)". Edge = mean net result > 0 with t ≥ 2;
otherwise the UI and the copilot say **"No edge after costs."** *Amended 2026-09-27 (IRTC R3-03):*
the t-statistic accounts for dependence. Rows are clustered in time buckets of one horizon (every
forecast in a bucket, on any instrument, is one observation), and the variance of the bucket means
is a HAC (truncated-kernel) long-run variance with a lag covering the longest horizon; the bucket
count is the effective sample size and a positive edge needs ≥ 30 buckets
(`apps/api/src/ai/core/edge-stat.ts`, table `ai_calibration_edge`, migration 0131). Bins without a
statistic built from their rows (seeded demo tables) can say "none" but never "positive". In the
no-skill simulation (8 correlated walks, a 24-bar forecast every bar, 120 seeds) the pooled row
test called 45 seeds positive (t sd 6.0); the clustered test calls 3 (t sd 1.14; nominal ≈ 2.3 %). The model never produces a
confidence; the system prompt forbids it and the numeric-fidelity guard removes invented figures.

`ai_regime` (goal 06 condition) is **not** filled: there is no cheap calibrated regime model on
SIMULATED data yet. It keeps evaluating to `not_available`; B-701 hands it to 07B's regime detector.

### 4. Explainability

The why-panel's bar chart is rendered from `GET /signals/:id/features` (stored contributions), never
from model text. The model explains from the same data (server grounding or `get_signal_features`),
and the numeric-fidelity eval requires every number to match exactly.

### 5. Budgets, cache, metrics

Redis counters: per-user and per-org daily token budgets and a per-user requests/min limit;
exceeding one returns `{status: 'budget_exceeded' | 'rate_limited', message, retryAfterSeconds}`
(HTTP 200). Response cache keyed by model + prompt hash (the grounded prompt, including the
pseudonymous user), TTL `KORA_AI_CACHE_TTL_S`, never for turns that created drafts or tripped a
guard. `prom-client` metrics at `GET /metrics` (optional bearer `KORA_METRICS_TOKEN`); the cost
counter uses env prices, so the repo holds no model names or prices. Dashboard:
`infra/grafana/provisioning/dashboards/ai-copilot.json`; Prometheus scrapes the api.

### 6. Evals (`services/ai-evals`)

80 cases (grounded explanation, numeric fidelity, refusal, injection, novice readability,
calibration honesty, drafts), graded by deterministic code: numeric fidelity (exact / rounded
against tool outputs), required citations, tool usage and allow-lists, refusal cue, execution-claim
detector, canary, Flesch–Kincaid grade ≤ 8, trade-suggestion detector, disclaimer, draft kind,
prompt integrity (untrusted blocks closed exactly once). Raw model text is graded for quality;
the final server output is graded for safety. Thresholds: overall ≥ 0.90, injection and refusal
= 1.00. CI runs `pnpm evals` (scripted provider); `pnpm evals:live` runs the same cases against
Anthropic when `ANTHROPIC_API_KEY` and `KORA_AI_MODEL` are set (adversarial cases keep the scripted
hostile model because they test the server, not the model).

## Threat model (STRIDE, S9)

Assets: the user's paper account and orders, robots and strategy versions, the audit chain, the
user's personal data, the organisation's AI budget, trust in shown numbers.

| # | Threat | STRIDE | Mitigation | Evidence |
|---|---|---|---|---|
| T1 | Prompt injection in news, calendar text, notes, strategy/robot names makes the model trade | T, E | No execution tool exists; dispatcher refuses unknown names; module cannot reach OMS/robot mutations (static test); untrusted text wrapped with neutralised delimiters; system prompt says data is data | `ai.static.test.ts`, adversarial integration test, 16 injection eval cases (100 %) |
| T2 | Direct jailbreak ("ignore your rules", developer mode) | E | Same server-side limits; execution-claim guard rewrites any "I placed your order" | refusal + injection evals, guard unit tests |
| T3 | Hallucinated numbers presented as facts | T (integrity of information) | Numeric-fidelity guard replaces unverified numbers with "[unverified]"; charts from data; confidence only from the calibration table | guard tests, numeric-fidelity evals, seeded-table test |
| T4 | Overconfident or unfounded confidence / no-edge strategies promoted as good | Repudiation of risk | Calibrated bins with minimum n; "No edge after costs" stated; no confidence below n | calibration unit and integration tests |
| T5 | Personalised advice framing / unsuitable suggestions to novices | Compliance | System prompt; novice mode: no draft tools, readability ≤ 8, suggestion detector → safe fallback; "Not investment advice." on every answer | novice evals, integration test |
| T6 | Cross-user data access through tools | I | Tools run as the user with the REST visibility rules; RBAC per tool; ids from other users → not found | integration tests (owner checks), dispatcher role tests |
| T7 | PII leakage to the provider | I | Pseudonymous user ref (salted hash), e-mail/phone/IBAN/card/id redaction in free text, PII keys stripped from tool outputs and grounding | PII unit tests |
| T8 | Cost exhaustion / DoS through the copilot | D | Per-user and per-org token budgets, per-user rate limit, max tool rounds, max tokens, cache | budget integration test, metrics |
| T9 | Forged draft acceptance (claiming an unrelated order or version) | S, R | Decision endpoint checks ownership, `ai-draft-accepted` source and symbol / authorship and strategy; drafts decided once (trigger) | integration tests |
| T10 | Untraceable AI actions | R | `ai.request`, `ai.tool_call`, `ai.draft`, `ai.draft_accepted/rejected` in the hash-chained audit log with model id and prompt hash | integration test on audit rows |
| T11 | Test doubles serving production | S | `scripted`/`replay` forced to `anthropic` outside dev/test; model and key from env / vault only | config unit tests |
| T12 | Metrics endpoint information disclosure | I | Optional bearer token (`KORA_METRICS_TOKEN`, required in deployments); no user ids in labels | integration test |
| T13 | Supply chain (SDK) | T | Official SDK pinned in the lockfile; `pnpm audit` and Trivy in CI | CI |

Residual risks: the scripted CI provider proves the pipeline, graders and server guards, not the
real model's quality — the live eval is pending a key (OQ-A2). Output guards are heuristics
(regexes); they are defence in depth behind the structural guarantees. The provider's data
processing terms are a Sponsor item (OQ-A1).

## Consequences

- 07B plugs news scoring into the same gateway (structured outputs validated by schema, articles
  wrapped as untrusted data), writes trend forecasts into the calibration table and extends the eval
  cases; 08 places `ExplainThis`.
- Every new tool must be added to the catalogue with a role set and a novice flag; anything that
  mutates state other than a draft is out of scope by design (ADR change required).
