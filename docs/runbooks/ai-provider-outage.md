# Runbook — AI provider outage

Category `ai_provider_outage`. SLO-9. Controls: KC-21 (AI suggests, a human decides), KC-22 (AI
requests logged). Owner: S7 (AI engineering); SRE on call.

## Why this is low risk by design

The copilot and market intelligence **never execute**: they create drafts that a person confirms
(ADR 0007). When the provider is down, trading, risk checks, the kill switch and robots are
unaffected; users lose explanations, drafts and news scoring only.

## Symptoms and signals

- The copilot answers "Copilot unavailable" (`ai.request` audit events with `status: unavailable` or
  provider errors); `kora_ai_requests_total{status!="ok"}` rises on `/metrics`.
- News scoring stores articles as `unavailable` (no scores, no translations); Market Radar shows
  "No reliable signal" more often; trend summaries fall back to the scripted text.
- Budget exhaustion looks similar (`budget_exceeded`, `rate_limited`): that is **not** an outage.

## Steps

1. Log the incident (P3 by default: a feature is degraded with a clear fallback; P2 if it lasts beyond
   a business day).
2. Confirm with the provider's status page and a direct probe from the api host (network egress,
   proxy, TLS). Check the key and model configuration (`ANTHROPIC_API_KEY`, `KORA_AI_MODEL` from the
   vault; never hard-code a model id).
3. Do **not** switch to the scripted provider in production: it is a test double and is refused
   outside dev/test by configuration.
4. Keep the product honest: the UI already says the copilot is unavailable; no other copy is needed.
5. When the provider is back: re-score news stored as `unavailable` (B-755), confirm a copilot answer
   and a draft round trip, check the guard flags (`ungroundedNumbers`, `executionClaim`) on
   `ai.request` events (KC-22 evidence).
6. Resolve and review (P1/P2). If the provider's data-processing terms were involved (OQ-A1), inform
   Compliance.

## Evidence

KC-22 CSV (requests by status and model id for the window), KC-21 (drafts, accepted, rejected;
AI-draft orders placed by users only).
