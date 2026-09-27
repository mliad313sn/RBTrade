import { z } from 'zod';

import { isExplicitDevOrTest } from '../config/env-mode';

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

/**
 * Trading core settings (goal 03). Risk defaults are SIMULATED placeholders pending Compliance
 * (OQ-R3); an account can tighten them but never loosen them past these platform values.
 */
const Schema = z.object({
  KORA_PAPER_STARTING_CASH: decimal.default('100000'),
  KORA_PAPER_BASE_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  KORA_RISK_MAX_ORDER_NOTIONAL: decimal.default('1000000'),
  KORA_RISK_MAX_POSITION_NOTIONAL: decimal.default('2000000'),
  KORA_RISK_MAX_LEVERAGE: decimal.default('30'),
  KORA_RISK_DAILY_LOSS_LIMIT: decimal.default('5000'),
  KORA_RISK_WEEKLY_LOSS_LIMIT: decimal.default('10000'),
  KORA_RISK_MAX_ORDERS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
  /** Goal 08: optional platform monthly loss limit (empty = none; accounts may set their own). */
  KORA_RISK_MONTHLY_LOSS_LIMIT: z.union([decimal, z.literal('')]).default(''),
  /**
   * Goal 08 novice guardrails (SIMULATED placeholders pending Compliance, OQ-R3/OQ-R5): the wait
   * before a loosened limit applies, the cooling-off triggers, and the most a novice may borrow once
   * the knowledge check is passed and the 24 h wait is over.
   */
  KORA_NOVICE_LOOSEN_DELAY_HOURS: z.coerce
    .number()
    .min(0)
    .max(24 * 30)
    .default(24),
  KORA_NOVICE_COOLOFF_LOSING_TRADES: z.coerce.number().int().min(1).max(100).default(3),
  KORA_NOVICE_COOLOFF_DAILY_LOSS_PCT: decimal.default('5'),
  KORA_NOVICE_MAX_LEVERAGE: decimal.default('2'),
  /** Order endpoints per client per minute (throttler). */
  KORA_ORDER_RATE_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(600),
  /** Feed status older than this is treated as not ok (fill safety). */
  KORA_TRADING_STATUS_MAX_AGE_MS: z.coerce.number().int().min(500).max(600_000).default(5000),
  /** Matching loop: safety sweep for held orders, expiries and missed quote events. */
  KORA_ENGINE_SWEEP_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  KORA_ENGINE_ENABLED: bool(true),
  /** Daily roll (swaps) at this UTC hour: 21 ≈ 17:00 New York in summer time. */
  KORA_TRADING_ROLL_UTC_HOUR: z.coerce.number().int().min(0).max(23).default(21),
  KORA_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  /**
   * IRTC R2-20 / OQ-B3 (decided by the Product Owner under delegated Sponsor authority, PAPER only):
   * margin level = equity / margin used. Below the call level a margin-call alert is raised; below the
   * close-out level the largest losing position is closed at market until the level recovers.
   */
  KORA_MARGIN_CALL_LEVEL_PCT: decimal.default('100'),
  KORA_MARGIN_CLOSEOUT_LEVEL_PCT: decimal.default('50'),
  /** How often the engine sweep checks margin levels (0 = every sweep). */
  KORA_MARGIN_CHECK_MS: z.coerce.number().int().min(0).max(3_600_000).default(5000),
  /**
   * Test-only: symbols the engine treats as in session regardless of the calendar, so weekday-bound
   * e2e flows (EUR/USD) are deterministic at weekends (goal 04, ADR 0004). Refused outside dev/test.
   */
  KORA_TRADING_SESSION_OVERRIDE: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/))),
  KORA_ENV: z.enum(['dev', 'test', 'staging', 'production']).default('dev'),
});

export type TradingConfig = ReturnType<typeof loadTradingConfig>;

export function loadTradingConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Schema.parse(env);
  // IRTC R2-13: NODE_ENV=production counts as production even when KORA_ENV is unset (same
  // predicate as the main config), so the test aid can never be enabled in a production build.
  // IRTC R6-12: an unset KORA_ENV no longer counts as dev.
  const devOrTest = isExplicitDevOrTest(env);
  if (e.KORA_TRADING_SESSION_OVERRIDE.length > 0 && !devOrTest) {
    throw new Error(
      'KORA_TRADING_SESSION_OVERRIDE is a test aid and is refused unless KORA_ENV is explicitly dev or test (and never with NODE_ENV=production)',
    );
  }
  if (Number(e.KORA_MARGIN_CLOSEOUT_LEVEL_PCT) >= Number(e.KORA_MARGIN_CALL_LEVEL_PCT))
    throw new Error('KORA_MARGIN_CLOSEOUT_LEVEL_PCT must be below KORA_MARGIN_CALL_LEVEL_PCT');
  return {
    startingCash: e.KORA_PAPER_STARTING_CASH,
    baseCurrency: e.KORA_PAPER_BASE_CURRENCY,
    riskDefaults: {
      maxOrderNotional: e.KORA_RISK_MAX_ORDER_NOTIONAL,
      maxPositionNotional: e.KORA_RISK_MAX_POSITION_NOTIONAL,
      maxLeverage: e.KORA_RISK_MAX_LEVERAGE,
      dailyLossLimit: e.KORA_RISK_DAILY_LOSS_LIMIT,
      weeklyLossLimit: e.KORA_RISK_WEEKLY_LOSS_LIMIT,
      maxOrdersPerMinute: e.KORA_RISK_MAX_ORDERS_PER_MINUTE,
      monthlyLossLimit: e.KORA_RISK_MONTHLY_LOSS_LIMIT || undefined,
    },
    novice: {
      loosenDelayMs: Math.round(e.KORA_NOVICE_LOOSEN_DELAY_HOURS * 3_600_000),
      coolingOff: {
        losingTrades: e.KORA_NOVICE_COOLOFF_LOSING_TRADES,
        dailyLossPct: e.KORA_NOVICE_COOLOFF_DAILY_LOSS_PCT,
      },
      maxLeverage: e.KORA_NOVICE_MAX_LEVERAGE,
    },
    orderRateLimit: e.KORA_ORDER_RATE_LIMIT,
    statusMaxAgeMs: e.KORA_TRADING_STATUS_MAX_AGE_MS,
    sweepMs: e.KORA_ENGINE_SWEEP_MS,
    engineEnabled: e.KORA_ENGINE_ENABLED,
    rollUtcHour: e.KORA_TRADING_ROLL_UTC_HOUR,
    reconciliationIntervalMs: e.KORA_RECONCILIATION_INTERVAL_MS,
    margin: {
      callLevelPct: e.KORA_MARGIN_CALL_LEVEL_PCT,
      closeOutLevelPct: e.KORA_MARGIN_CLOSEOUT_LEVEL_PCT,
      checkMs: e.KORA_MARGIN_CHECK_MS,
    },
    sessionOverride: new Set(e.KORA_TRADING_SESSION_OVERRIDE),
  };
}

export const TRADING_CONFIG = Symbol('TRADING_CONFIG');
