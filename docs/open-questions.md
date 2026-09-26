# Open questions

Anything legal, regulatory, contractual or involving real money escalates to the **Sponsor** (charter §1). Placeholders stay visible in the UI until answered.

| ID | Question | Placeholder in product | Owner | Raised | Status |
|---|---|---|---|---|---|
| OQ-R1 | Regulatory retail-loss percentage for the risk banner, per jurisdiction | `[XX]%` in the Novice banner and disclosures | Sponsor / Compliance | goal 00 | Open |
| OQ-R2 | Target jurisdictions for launch (determines leverage caps, disclosures, cooling-off rules) | none (PAPER only) | Sponsor | goal 00 | Open |
| OQ-R3 | Leverage limits for retail vs professional clients | Novice leverage **Off**; Pro margin `1:30` shown as illustrative in the prototype | Sponsor / Compliance | goal 00 | Open |
| OQ-R4 | Record-retention period for audit events and order records | retain indefinitely in dev | Compliance | goal 01 | Open |
| OQ-B1 | Broker partner(s) and adapter capabilities (order types, FX conversion, swaps) | simulated paper engine only | Sponsor | goal 00 | Open |
| OQ-B2 | Market data licensing for real feeds | simulated feed labelled "Simulated feed · not market data" | Sponsor | goal 00 | Open |
| OQ-S1 | Production IdP: self-hosted Keycloak vs managed OIDC; password policy and MFA recovery (backup codes) policy | dev IdP; no recovery codes yet | S9 / Sponsor | goal 01 | Open |
| OQ-S2 | Is self-service `trader` account type acceptable at sign-up, or must it pass an appropriateness test first? | **Decided by Sponsor 2026-09-26:** no self-service `trader`. Everyone signs up as `novice`; `trader` is granted only after passing an appropriateness assessment (questionnaire engine, goal 08/09), recorded with the questionnaire version and audit-logged. See B-018. | S8 / Compliance | goal 01 | Resolved |
| OQ-D1 | The `.dc.html` prototype sources are referenced but only PNG exports are in the repo | PNGs used as reference | Product Owner | goal 00 | Open |
| OQ-D2 | Buy button text colour: the prototype shows white on `#4DA3FF` (2.6:1, fails AA). We use ink `#0B0E13` on up/down fills (> 7:1). | **Decided by Sponsor 2026-09-26:** keep dark ink text on buy/sell fills. | Product Owner (S1) | goal 01 | Resolved |
| OQ-A1 | AI provider data-processing agreement and allowed data categories | copilot not built | Sponsor | goal 00 | Open |
| OQ-M1 | Licensed market-data providers per region (Americas, Europe, Africa, Asia, Oceania) and exchange redistribution licences | SimulatedAdapter + flagged stubs | Sponsor | goal 07B | Open |
| OQ-M2 | Licensed news provider(s), languages and AI-processing rights | SIMULATED news fixtures | Sponsor | goal 07B | Open |
