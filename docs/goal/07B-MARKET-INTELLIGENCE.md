# /goal 07B — Market Intelligence: global scanner, news analysis and trend detection

**Requested by:** Sponsor, 2026-09-26. **Lead seats:** S7 AI engineer, S5 quant developer, S2 senior trader, S8 compliance.
**Load first:** `docs/goal/00-MASTER-GOAL.md`, `docs/STATUS.md`, `docs/adr/0002-market-data.md`, `docs/adr/0007-ai-copilot.md`.
**Depends on:** 02 (global registry), 05 (quant service), 06 (signal/feature store, calibration), 07 (AI gateway, safety, evals).

## Goal
Give every user an AI helper that continuously **scans all markets and news**, identifies and forecasts **trends** (up / down / range / breakout / reversal / volatility regime), and explains each one clearly with the evidence behind it. It must work for **any asset class on any exchange on all five continents**.

It follows every master-goal principle:
- The AI never executes trades.
- A confidence figure is shown only if it is calibrated.
- All news is untrusted data.
- Every call is audit-logged.
- It is never presented as personal investment advice.

## Scope
1. **Global coverage**
   - The instrument/venue registry from goal 02 covers these asset classes: equities, ETFs, bonds, futures, options, FX, metals, energy, agricultural commodities, crypto, indices, CFDs and funds.
   - Venues are identified by ISO 10383 MIC and grouped by region: Americas, Europe, Africa, Asia, Oceania.
   - Each venue records its time zone, currency, sessions and holidays.
   - The provider adapter matrix lists the data sources per region. Each entry is a flagged stub until the sponsor signs a licensed data contract.
   - The UI handles multiple currencies, with FX conversion shown as a cost.
   - Instrument names and news are localised; the source language is detected and the text translated.
2. **Scanner engine** (`services/quant/scanner`)
   - Incremental scans over the universe on bar close, per timeframe.
   - Detectors:
     - trend strength (ADX, slope t-stat);
     - regime (HMM or volatility-clustering model);
     - breakouts and range compression;
     - momentum and mean-reversion z-scores;
     - relative strength against the sector and the index;
     - cross-asset correlation breaks;
     - volume and volatility anomalies;
     - seasonality;
     - event proximity from the economic calendar.
   - Each detector outputs features with their values, never prose.
   - The scanner must process 10,000 instruments on 1-hour bars within 60 s on the reference host (benchmark committed).
3. **Trend forecasts**
   - Output: probabilistic direction or regime forecasts per instrument and horizon (for example 1 day, 1 week, 1 month).
   - Models: gradient-boosted and/or logistic models trained point-in-time with walk-forward validation. The goal 06 look-ahead guard test applies.
   - Calibration: isotonic or Platt, stored in the goal 07 calibration table and displayed as "when we said 0.6, it happened 57% of the time (n=…)".
   - A forecast with no demonstrated out-of-sample skill after costs is shown as **"No reliable signal"**. It is never hidden behind a confidence number.
4. **News and sentiment**
   - A news ingestion adapter interface; providers are flagged stubs and the fixtures are clearly SIMULATED.
   - Pipeline: deduplication, entity linking to instruments and venues, then per-article sentiment, relevance and novelty scores from Claude via the AI gateway.
   - The model outputs structured scores only, validated by a schema, with the article text wrapped as untrusted data.
   - Each article is stored with its source, timestamp and link, so every explanation can cite it.
5. **Explanations** — each trend card shows:
   - direction and horizon;
   - calibrated probability, or "No reliable signal";
   - the top drivers as a feature-contribution chart built from data (SHAP for the ML models);
   - linked news items with their sources;
   - what would invalidate the view;
   - the risk and volatility context;
   - "not investment advice".
   Claude writes the plain-language summary, grounded only in tool outputs. Every number in the summary must match a tool output (numeric-fidelity eval). Novice mode uses readability grade 8 or below and makes no trade suggestion.
6. **Surfaces**
   - Pro: a "Market Radar" screen with a filterable heat map by region, asset class and sector, a ranked list of emerging trends, alerts (server-evaluated) and a "Draft to ticket" or "Send to Robot builder" action.
   - Novice: "What's moving and why" cards in plain words.
   - The copilot can answer questions such as "What is trending in Asian equities this week and why?".
7. **Track record** — every forecast is logged with a timestamp before its outcome is known. The public reliability page per model and region is computed from these stored predictions and outcomes.

## Acceptance criteria
- [ ] The registry and simulated feed cover at least one venue per continent across all listed asset classes. Session status is correct across DST and holidays (tests for XNYS, XLON, XTKS, XHKG, XJSE, BVMF, XASX).
- [ ] Scanner detectors match hand-computed values on fixed series, and the look-ahead guard test fails when future data is injected.
- [ ] The displayed probability comes from the calibration table (seeded-table test). A model without out-of-sample skill displays "No reliable signal".
- [ ] News prompt-injection suite passes 100%. Every sentiment output validates against the schema. Explanations cite stored article IDs.
- [ ] Numeric-fidelity eval: 100% of numbers in the explanations match tool outputs. Novice readability is grade 8 or below.
- [ ] The scanner benchmark is committed. The Market Radar e2e flow runs: filter by region → open a trend → see drivers and news → draft to ticket, and preview/confirm is still required.
- [ ] Every data provider is a flagged stub, with the real licensing need logged in `docs/open-questions.md`. No real market or news data is committed.
- [ ] `docs/adr/0007b-market-intelligence.md` and the STATUS update are written.
