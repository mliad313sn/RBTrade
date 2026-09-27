import { z } from 'zod';

/**
 * Gain simulator request schemas (goal 05). They mirror services/quant/src/kora_quant/sim/models.py
 * and reject silly values with plain explanations before anything reaches the quant service.
 */

const MAX_PATHS = 50_000;
const MAX_TRADES_PER_PATH = 5_000;
const MAX_WORK = 50_000_000;

const pct = (label: string, min: number, max: number, why?: string) =>
  z
    .number({ error: `${label} must be a number` })
    .min(min, `${label} must be at least ${min}%${why ? ` (${why})` : ''}`)
    .max(max, `${label} must be at most ${max}%${why ? ` (${why})` : ''}`);

const WithdrawalsSchema = z
  .object({
    perPeriod: z.number().min(0, 'Withdrawals cannot be negative').max(1e12).default(0),
    oneOff: z
      .array(
        z.strictObject({
          period: z.number().int().min(1).max(600),
          amount: z.number().min(0, 'Withdrawals cannot be negative').max(1e12),
        }),
      )
      .max(120)
      .default([]),
  })
  .strict();

const RunShape = {
  startingCapital: z
    .number()
    .positive('Starting capital must be above zero')
    .max(1e12, 'Starting capital is unrealistically large')
    .default(10_000),
  tradesPerPeriod: z
    .number()
    .int()
    .min(1, 'At least one trade per period')
    .max(500, 'At most 500 trades per period')
    .default(20),
  horizonPeriods: z
    .number()
    .int()
    .min(1, 'Horizon must be at least one period')
    .max(600, 'Horizon is at most 600 periods')
    .default(24),
  ruinFloorPct: pct(
    'Ruin floor',
    0,
    99,
    'share of starting capital at which you would stop',
  ).default(50),
  withdrawals: WithdrawalsSchema.default({ perPeriod: 0, oneOff: [] }),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(1),
  paths: z
    .number()
    .int()
    .min(100, 'Use at least 100 paths, or the bands are noise')
    .max(MAX_PATHS, `At most ${MAX_PATHS.toLocaleString('en-US')} paths`)
    .default(10_000),
};

function budget<T extends { tradesPerPeriod: number; horizonPeriods: number; paths: number }>(
  v: T,
  ctx: z.RefinementCtx,
) {
  const trades = v.tradesPerPeriod * v.horizonPeriods;
  if (trades > MAX_TRADES_PER_PATH) {
    ctx.addIssue({
      code: 'custom',
      path: ['horizonPeriods'],
      message: `Trades per period × horizon = ${trades} trades per path; the limit is ${MAX_TRADES_PER_PATH}. Shorten the horizon or trade less often.`,
    });
  } else if (trades * v.paths > MAX_WORK) {
    ctx.addIssue({
      code: 'custom',
      path: ['paths'],
      message: `Paths × trades = ${(trades * v.paths).toLocaleString('en-US')} exceeds ${MAX_WORK.toLocaleString('en-US')}. Reduce the number of paths or the horizon.`,
    });
  }
}

export const ProjectRequestSchema = z
  .strictObject({
    ...RunShape,
    sizingModel: z
      .enum(['fixed_fractional', 'fixed_amount', 'kelly_fraction'])
      .default('fixed_fractional'),
    riskPct: z
      .number()
      .gt(0, 'Risk per trade must be above 0%')
      .max(25, 'Risk per trade above 25% is not a trading plan; the simulator refuses it')
      .default(1),
    fixedAmount: z.number().positive('The fixed amount must be above zero').max(1e12).default(100),
    kellyFraction: z
      .number()
      .gt(0, 'Kelly fraction must be above 0')
      .max(2, 'Kelly fraction is at most 2× full Kelly')
      .default(0.5),
    winRatePct: pct('Win rate', 1, 99, 'no strategy wins never or always').default(45),
    avgWinR: z
      .number()
      .min(0.05, 'Average win must be at least 0.05 R')
      .max(20, 'Average win above 20 R is not credible')
      .default(1.8),
    costPerTradeR: z
      .number()
      .min(0, 'Costs cannot be negative')
      .max(5, 'Costs above 5 R per trade are not credible')
      .default(0.08),
    fatTailProbPct: pct('Fat-tail probability', 0, 50).default(0),
    fatTailMultiple: z
      .number()
      .min(1, 'A fat-tail loss is at least 1 R')
      .max(20, 'Fat-tail multiple is at most 20 R')
      .default(3),
    stressEdgeCutPct: pct('Stress edge cut', 0, 100).default(0),
  })
  .superRefine(budget);
export type ProjectRequest = z.infer<typeof ProjectRequestSchema>;

export const FromTradesRequestSchema = z
  .strictObject({
    ...RunShape,
    trades: z
      .array(z.number().finite())
      .min(2, 'Import at least two trades')
      .max(20_000, 'At most 20,000 trades can be imported'),
    tradeUnit: z.enum(['r_multiple', 'pct_return']).default('r_multiple'),
    riskPct: z.number().gt(0).max(25, 'Risk per trade above 25% is refused').default(1),
    extraCostPerTradeR: z.number().min(0).max(5).default(0),
    blockSize: z.number().int().min(1).max(1000).nullable().default(null),
    source: z
      .enum(['backtest_in_sample', 'backtest_out_of_sample', 'paper', 'manual'])
      .default('manual'),
  })
  .superRefine(budget)
  .superRefine((v, ctx) => {
    if (v.blockSize !== null && v.blockSize > v.trades.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['blockSize'],
        message: 'Block size cannot exceed the number of imported trades',
      });
    }
    // IRTC R3-07: a cost in R cannot be applied to % returns, so it is refused, never ignored.
    if (v.tradeUnit === 'pct_return' && v.extraCostPerTradeR > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['extraCostPerTradeR'],
        message:
          'Extra costs in R cannot be applied to % returns: import R multiples, or include the costs in the returns',
      });
    }
  });
export type FromTradesRequest = z.infer<typeof FromTradesRequestSchema>;

/** "Project from my paper results": the trade list comes from the paper account, not the client. */
export const PaperProjectRequestSchema = z
  .strictObject({
    tradesPerPeriod: RunShape.tradesPerPeriod,
    horizonPeriods: RunShape.horizonPeriods,
    ruinFloorPct: RunShape.ruinFloorPct,
    seed: RunShape.seed,
    paths: RunShape.paths,
    blockSize: z.number().int().min(1).max(1000).nullable().default(null),
  })
  .superRefine(budget);
export type PaperProjectRequest = z.infer<typeof PaperProjectRequestSchema>;

/** Subset of the quant response the api reads (the rest is passed through untouched). */
export interface SimResultMeta {
  kind: 'project' | 'from_trades';
  inputHash: string;
  cache: 'hit' | 'miss';
  paths: number;
  tradesPerPath: number;
  realityChecks: { code: string; severity: string }[];
  [key: string]: unknown;
}

export interface PaperAnalyticsMeta {
  trades: number;
  endingEquity: string;
  tradeReturnsPct: number[];
  [key: string]: unknown;
}
