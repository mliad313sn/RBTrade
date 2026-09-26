import { z } from 'zod';

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
   * Test-only: symbols the engine treats as in session regardless of the calendar, so weekday-bound
   * e2e flows (EUR/USD) are deterministic at weekends (goal 04, ADR 0004). Refused outside dev/test.
   */
  KORA_TRADING_SESSION_OVERRIDE: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/))),
  KORA_ENV: z.enum(['dev', 'test', 'staging', 'production']).default('dev'),
});

export type TradingConfig = ReturnType<typeof loadTradingConfig>;

export function loadTradingConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Schema.parse(env);
  if (e.KORA_TRADING_SESSION_OVERRIDE.length > 0 && !(e.KORA_ENV === 'dev' || e.KORA_ENV === 'test')) {
    throw new Error('KORA_TRADING_SESSION_OVERRIDE is a test aid and is refused outside KORA_ENV=dev|test');
  }
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
    },
    orderRateLimit: e.KORA_ORDER_RATE_LIMIT,
    statusMaxAgeMs: e.KORA_TRADING_STATUS_MAX_AGE_MS,
    sweepMs: e.KORA_ENGINE_SWEEP_MS,
    engineEnabled: e.KORA_ENGINE_ENABLED,
    rollUtcHour: e.KORA_TRADING_ROLL_UTC_HOUR,
    reconciliationIntervalMs: e.KORA_RECONCILIATION_INTERVAL_MS,
    sessionOverride: new Set(e.KORA_TRADING_SESSION_OVERRIDE),
  };
}

export const TRADING_CONFIG = Symbol('TRADING_CONFIG');
