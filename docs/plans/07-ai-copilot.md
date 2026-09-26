# Plan 07 — AI Copilot: explain, analyse, draft, never execute

Lead seats: S7 (AI engineer), S9 (security engineer), S8 (risk & compliance).
Inputs: master goal (incl. the 2026-09-26 scope amendment), goal 07, goal 07B (the next goal reuses
this gateway), STATUS (goal 04 "AI strip slot / ticket prefill", goal 06 "signal feature store /
strategy draft API / calibration hooks"), ADRs 0000–0102, BACKLOG (B-601, B-602), prototype
`design/prototype/Main.png` (AI strip) and `Robots.png` (copilot drawer).

Parallel work: goal 08 (Novice view, i18n, onboarding, PWA) is built in another worktree. This goal
owns `apps/api/src/ai`, `services/ai-evals`, `apps/web/src/components/ai` + `apps/web/src/lib/ai`,
migrations `0070+`. Shared files (app module, app shell, STATUS row + section, BACKLOG B-701+,
open-questions, `.env.example`, lockfile) get additive edits only. No novice route is edited: goal 08
places the exported `ExplainThis` component.

## 1. Decisions up front

| Topic | Decision | Why |
|---|---|---|
| SDK and model | Official `@anthropic-ai/sdk` in `apps/api/src/ai/providers/anthropic.provider.ts` only. Model id **only** from `KORA_AI_MODEL`; no default and no model name anywhere in the repo. Unset → the copilot answers `{status:'unavailable', message:'Copilot unavailable …'}` (HTTP 200, friendly). Key from `ANTHROPIC_API_KEY` (env / vault). | Master goal; fail closed. |
| Provider abstraction | `AiProvider.complete(request, onTextDelta)` over SDK types (`MessageParam`, `Tool`, `Message`). Implementations: `anthropic` (streaming `messages.stream` + `finalMessage()`, system prompt and tools cached with `cache_control`, optional adaptive thinking and effort from env), `scripted` (deterministic reference policy + an `adversarial` persona for security tests), `replay` (recorded cassettes keyed by request hash; a `record` wrapper writes them from live runs). `scripted`/`replay` are refused outside dev/test. | No key in this environment; CI must be deterministic; live runs stay possible. |
| Framework-free core | `apps/api/src/ai/core/*` has no Nest imports: prompts, untrusted-data wrapping, PII minimiser, tool catalogue (zod → JSON schema, strict), dispatcher, guards (numeric fidelity, execution claims, readability, trade-suggestion detector), calibration maths, the conversation engine. The Nest layer injects a DB-backed `ToolBackend`; the eval harness injects a SIMULATED fixture backend. Exported for `services/ai-evals` via `@kora/api/ai`. | One engine for the product, the integration tests and the evals. |
| Tools | Read-only: `get_quote, get_candles, get_indicators, get_positions, get_account_risk, get_order_preview, get_calendar, get_strategy, get_backtest_results, get_bot_signals, get_signal_features, get_mc_projection, get_calibration`. Draft-only: `create_order_draft, create_strategy_draft`. Each tool: strict zod input (→ `strict: true` JSON schema), required roles, `novice` flag, untrusted string fields. The dispatcher (server side) rejects unknown names (`tool_not_available`), invalid input, missing roles; every call is audited. | Goal 07 §2. |
| No execution, by construction | The AI module never imports `OmsService` or robot control. `get_order_preview` goes through `OrderPreviewPort` (a one-function adapter bound to `OmsService.preview`, the only file allowed to touch the OMS). Static test scans `apps/api/src/ai/**` for `submit(`, `amend(`, `cancel`, `start(`, `promote`, `newVersion(` and robot/OMS imports. Runtime test: the adversarial provider calls every tool with order-like payloads plus `submit_order`, `amend_order`, `cancel_order`, `close_position`, `start_robot`, `promote_robot`, `save_strategy_version`; orders, robots and strategy versions are unchanged, every attempt is audited as refused. | Acceptance 1; "enforced server-side, not by prompt". |
| Drafts | `create_order_draft` → `ai_order_drafts` (status `draft`); the response carries a `TicketDraft` prefill (`origin:'ai'`, `aiDraftId`). Only the user's click opens the ticket; the ticket sends `source:'ai-draft-accepted'` after the normal preview + confirmation, then posts `POST /ai/drafts/:id/decision {accepted, orderId}`. `create_strategy_draft` applies parameter changes to the base version, validates through `StrategiesService.validate` (the same code as `POST /strategies/validate`) and stores `ai_strategy_drafts` (unapproved). Only a human saves a version (`POST /strategies/:id/versions`); the decision endpoint records the resulting version id. | Master goal "AI suggests, never executes"; goal 04/06 hand-overs. |
| Calibration | `ai_predictions` (model key, subject, predicted probability, outcome, net return after costs, source, times) and `ai_calibration_bins` (10 bins: n, hits, mean predicted, mean net return). Model keys: `strategy:<id>` (OOS backtest trades: raw score = mean entry-condition contribution mapped to 0…1, outcome = net P&L > 0), `bias:<symbol>:<tf>` (the strip's bias rule replayed over SIMULATED history: outcome = move in the bias direction beyond the spread cost after 4 bars). Confidence shown = hit rate of the bin that contains the current raw score, only if `n ≥ KORA_AI_CALIBRATION_MIN_N` (30); reliability line "When we said 0.6, it worked 57% of the time (n=212)". Edge = mean net return > 0 with t ≥ 2; otherwise **"No edge after costs"** in plain words. 07B writes its own model keys into the same tables. | Goal 07 §4, 07B §3. |
| `ai_regime` | Not filled: no cheap calibrated regime model exists yet (SIMULATED data, no labels). Stays `not_available`; logged as B-701 for 07B's regime detector. | Instruction: only if cheap. |
| Surfaces | Terminal strip (registered with `registerAiStrip`, `KORA_AI_STRIP=on`): bias, calibrated confidence or "No edge after costs", top drivers, event risk, "Draft to ticket", "Why?" (streams an explanation). Robots copilot drawer: why-panel (feature chart from `GET /signals/:id/features`, text from the model), confidence + reliability, data-derived suggestions with "Create draft", no-edge scan, "Ask the copilot" chat. Chat carries the focused panel as context and streams (SSE). Novice: `ExplainThis` component (plain words, grade ≤ 8, no suggestions, no draft tools). | Goal 07 §5. |
| Safety | Stable system prompt (cached) forbids personalised advice, execution claims and confidence numbers not returned by `get_calibration`; every answer ends with "Not investment advice."; untrusted text (notes, news, calendar descriptions, strategy/robot names) wrapped as `<untrusted_data source=… id=…>` with delimiter lookalikes neutralised; PII minimiser (pseudonymous user ref, emails/phones/IBAN/card-like strings redacted). Output guards: ungrounded numbers are replaced by "[unverified]" and flagged; execution claims are replaced; novice answers above grade 8 or with trade suggestions fall back to a templated safe explanation. | Goal 07 §6. |
| Audit | `ai.request` (surface, model id, prompt hash, tokens, cached, status, guard flags), `ai.tool_call` (tool, outcome, input hash, refused reason), `ai.draft` (order/strategy), `ai.draft_accepted` / `ai.draft_rejected`; actor `ai` for model actions, `user` for decisions. | Goal 07 §6. |
| Budgets, rate limits, cache | Redis: per-user and per-org daily token budgets (`KORA_AI_USER_DAILY_TOKENS`, `KORA_AI_ORG_DAILY_TOKENS`), per-user requests/min (`KORA_AI_RATE_PER_MIN`). Exceeding → HTTP 200 `{status:'budget_exceeded'|'rate_limited', message}`. Response cache keyed by model + prompt hash (grounded context included), TTL `KORA_AI_CACHE_TTL_S`; never caches draft-creating turns. | Goal 07 §1. |
| Metrics | `prom-client` registry at `GET /metrics` (optional bearer `KORA_METRICS_TOKEN`): `kora_ai_requests_total`, `kora_ai_tokens_total{kind}`, `kora_ai_cost_usd_total` (prices from env, no model names), `kora_ai_tool_calls_total`, `kora_ai_budget_denials_total`, `kora_ai_cache_hits_total`, `kora_ai_request_duration_seconds`, `kora_ai_org_tokens_used`. Grafana dashboard JSON `infra/grafana/dashboards/ai-copilot.json` + provisioning; Prometheus scrapes the api. | Acceptance 5. |
| Evals | `services/ai-evals` (≥ 60 cases, JSON): grounded explanation, numeric fidelity, refusal to execute, injection (100 % required), novice readability, calibration honesty, draft behaviour. Deterministic graders in code. `pnpm evals` runs against the scripted provider in CI with threshold `0.9` overall and `1.0` for injection + refusal; `pnpm evals:live` runs the same cases against Anthropic when `ANTHROPIC_API_KEY` and `KORA_AI_MODEL` are set. | Goal 07 §7. |

## 2. Files

- `apps/api/migrations/0070_ai.sql`: `ai_order_drafts`, `ai_strategy_drafts`, `ai_predictions`, `ai_calibration_bins` (+ grants).
- `apps/api/src/ai/core/`: `types.ts`, `config.ts`, `prompts.ts`, `untrusted.ts`, `pii.ts`, `hash.ts`, `tools.ts` (catalogue + dispatcher), `guards.ts`, `readability.ts`, `calibration.ts`, `engine.ts`, `index.ts`.
- `apps/api/src/ai/providers/`: `anthropic.provider.ts`, `scripted.provider.ts`, `replay.provider.ts`, `select.ts`.
- `apps/api/src/ai/`: `ai.module.ts`, `ai.controller.ts`, `ai.service.ts`, `tool-backend.service.ts`, `order-preview.port.ts`, `drafts.service.ts`, `calibration.service.ts`, `strip.service.ts`, `insights.service.ts`, `budget.service.ts`, `cache.service.ts`, `metrics.service.ts`, `metrics.controller.ts`, unit tests.
- `apps/api/test/ai.int.test.ts`, `ai-security.int.test.ts`.
- `services/ai-evals/`: `package.json`, `src/cases/*.json`, `src/fixtures.ts`, `src/graders.ts`, `src/run.ts`, tests.
- `apps/web/src/lib/ai/` (client, SSE reader), `apps/web/src/components/ai/` (`CopilotStrip`, `RobotCopilot`, `CopilotChat`, `ExplainThis`, `FeatureChart`), terminal registration, `/robots` drawer, ticket decision hook, SSE pass-through in the `/api` proxy.
- `infra/grafana/dashboards/ai-copilot.json`, `infra/grafana/provisioning/dashboards/kora.yaml`, `infra/prometheus/prometheus.yml` scrape job.
- Docs: this plan (results in §6), `docs/adr/0007-ai-copilot.md` (threat model), STATUS, BACKLOG B-701+, open-questions, `.env.example`.

## 3. Schema (0070)

`ai_order_drafts(id, user_id, surface, symbol, side, type, qty, limit_price, stop_loss_price, take_profit_price, rationale, preview jsonb, status draft|accepted|rejected, order_id, audit_event_id, created_at, decided_at)`;
`ai_strategy_drafts(id, user_id, strategy_id, base_version_id, definition jsonb, param_changes jsonb, content_hash, validation jsonb, rationale, status, saved_version_id, created_at, decided_at)`;
`ai_predictions(id, model_key, subject, horizon, predicted numeric(6,5), outcome boolean, net_return double, source live|backtest_oos|history_replay|seed, predicted_at, resolved_at, meta jsonb)`;
`ai_calibration_bins(model_key, bin, lo, hi, n, hits, mean_predicted, mean_net_return, updated_at, PK(model_key, bin))`.
Drafts: status changes only draft → accepted|rejected (trigger), rows never deleted by the app role.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Model hallucinates numbers | Numeric-fidelity guard on every answer + eval; UI charts from data, not text. |
| Prompt injection through news/notes/names | Wrapping + neutralised delimiters + tool allow-list + server RBAC + output guard; injection suite 100 %. |
| The AI trades | No OMS/robot import; port pattern; static + runtime tests. |
| Cost runaway | Token budgets, rate limits, cache, max 6 tool rounds, max tokens per turn. |
| Replay evals over-state quality | Documented: CI proves the harness, graders and server guards; model quality needs the live run (pending a key, open question OQ-A2). |
| Parallel goal 08 conflicts | Additive shared edits, migration 0070, no novice route edits. |

## 5. Test plan

Unit (api): guards, readability, untrusted wrapping, PII, calibration maths, tool schemas (strict), engine with scripted/adversarial providers, provider selection (fail closed), static no-execute scan.
Integration (real Postgres + Redis): every tool via the engine as trader and novice; adversarial run leaves orders/robots/versions unchanged; order draft → ticket source `ai-draft-accepted` still needs preview/confirm path; strategy draft saves no version; budgets and rate limits return friendly messages and metrics move; seeded calibration table → strip confidence and reliability line; audit events carry model id + prompt hash; cache hit.
Evals: `pnpm evals` (scripted) in CI; `pnpm evals:live` documented.
E2E: terminal strip with seeded calibration → "Draft to ticket" pre-fills the ticket and placing still needs the confirmation; robots drawer why-panel chart + streamed answer + no-edge scan.

## 6. Results

(filled in at the end of the goal)
