import { z } from 'zod';

const pct = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/);

/**
 * Novice view settings (goal 08). Suggested loss limits and the auto-invest cap are SIMULATED
 * placeholders pending Compliance (OQ-R5); the guardrail thresholds themselves live in the trading
 * config because the OMS enforces them.
 */
const Schema = z.object({
  /** Suggested daily / monthly loss limits in % of the practice balance (prototype: 150 / 600 on 10,000). */
  KORA_NOVICE_SUGGESTED_DAILY_LOSS_PCT: pct.default('1.5'),
  KORA_NOVICE_SUGGESTED_MONTHLY_LOSS_PCT: pct.default('6'),
  /** Most of the balance one auto-invest robot may use, in %. */
  KORA_NOVICE_AUTOINVEST_MAX_PCT: pct.default('25'),
  /** Smallest auto-invest amount, in % of the balance. */
  KORA_NOVICE_AUTOINVEST_MIN_PCT: pct.default('1'),
});

export type NoviceConfig = ReturnType<typeof loadNoviceConfig>;

export function loadNoviceConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Schema.parse(env);
  return {
    suggestedDailyLossPct: e.KORA_NOVICE_SUGGESTED_DAILY_LOSS_PCT,
    suggestedMonthlyLossPct: e.KORA_NOVICE_SUGGESTED_MONTHLY_LOSS_PCT,
    autoInvestMaxPct: e.KORA_NOVICE_AUTOINVEST_MAX_PCT,
    autoInvestMinPct: e.KORA_NOVICE_AUTOINVEST_MIN_PCT,
  };
}

export const NOVICE_CONFIG = Symbol('NOVICE_CONFIG');

/** The risk warning every novice acknowledges during onboarding (disclosures module id). */
export const RISK_WARNING_ID = 'risk-warning';
export const KNOWLEDGE_CHECK_ID = 'knowledge-check';
