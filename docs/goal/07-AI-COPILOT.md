# /goal 07 — AI Copilot (Claude API): explain, analyse, draft, never execute

**Load first:** `docs/goal/00-master.md`, `docs/STATUS.md`, `Main.dc.html` (AI strip), `Robots.dc.html` (copilot drawer).

## Goal
Add an AI copilot powered by the Anthropic Claude API. It explains signals and results, spots risk, and drafts orders or strategy changes that a human must approve. It must be grounded in platform data, calibrated, auditable and safe against prompt injection. It has **no ability to place, amend or cancel orders**.

## Scope
1. **AI gateway (`apps/api/ai`):**
   - uses the official Anthropic SDK; the model comes from `KORA_AI_MODEL` and the key from the secret store;
   - streaming responses;
   - per-user and per-org token budgets and rate limits;
   - a response cache for identical grounded requests;
   - token usage and cost metrics sent to Prometheus.
2. **Tools exposed to the model (read-only plus draft-only):**
   - `get_quote`, `get_candles`, `get_indicators`, `get_positions`, `get_account_risk`, `get_order_preview`, `get_calendar`;
   - `get_strategy`, `get_backtest_results`, `get_bot_signals(bot_id, from, to)`, `get_signal_features(signal_id)`, `get_mc_projection`;
   - `create_order_draft`: writes a draft that pre-fills the ticket and cannot submit it;
   - `create_strategy_draft`: writes a new unapproved version.

   Tool schemas are strict (zod → JSON schema). The server validates every tool call against the user's RBAC. No tool can submit orders, and this is enforced server-side, not by prompt.
3. **Explainability:**
   - The bot runner stores per-signal feature values and contributions (for rule strategies: which conditions fired and their margins; for any ML regime model: SHAP values).
   - The copilot's "Why did this trade happen?" answer must cite those stored values. The UI renders a feature-contribution bar chart from data, not from model text.
4. **Calibration:**
   - Any confidence the copilot shows comes from a calibrated signal model or historical hit rate stored in the database, never from free-form model output.
   - Track predictions vs outcomes, and show a reliability line ("when we said 0.6, it worked 57% of the time, n=212").
   - If no edge is detected after costs, the copilot must say so plainly.
5. **Surfaces:**
   - Terminal AI strip: bias, calibrated confidence, top drivers, "Draft to ticket".
   - Robots copilot drawer: why-panel, suggestions such as "reduce risk until 100 live trades", scan for bots with no edge.
   - A chat input with context of the focused panel.
   - Novice: a plain-language "Explain this to me" button only, with no trade suggestions.
6. **Safety:**
   - The system prompt forbids personalised investment advice framing and must add a "not investment advice" line.
   - All untrusted text (news, calendar descriptions, user notes) is wrapped as data with delimiters, and instructions inside it are ignored.
   - A regression suite of prompt-injection attacks must pass.
   - PII is minimised in prompts.
   - Every AI request, tool call, draft and user accept/reject is audit-logged with the model id and prompt hash.
7. **Evaluation harness (`services/ai-evals`):** at least 60 graded cases covering:
   - grounded explanation accuracy against stored features;
   - refusal to execute;
   - injection resistance;
   - numeric fidelity (numbers must match tool outputs);
   - novice-language readability (grade ≤ 8).

   It runs in CI with a score threshold.

## Acceptance criteria
- [ ] No code path lets the AI submit, amend or cancel orders. There is a test that attempts it through every tool and prompt.
- [ ] "Why did Trend-X go long EUR/USD at 09:00?" returns an answer whose numbers match `get_signal_features` exactly (eval).
- [ ] Draft to ticket pre-fills the ticket, and submitting still requires the normal preview and confirmation.
- [ ] The injection suite passes 100%, and the overall eval score is ≥ the agreed threshold.
- [ ] Budgets hold: exceeding one returns a friendly message rather than an error, and usage is visible in Grafana.
- [ ] The confidence shown in the UI comes from the calibration table (test with a seeded table).
- [ ] `docs/adr/0007-ai-copilot.md` (including the threat model) and the STATUS update are written.
