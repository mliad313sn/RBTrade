/**
 * Response contracts (goal 10; B-004, B-209, B-312). These zod schemas describe what clients (the
 * web app through `@kora/sdk`, the bot runner) rely on. They are merged into the OpenAPI document
 * by `buildOpenApi`, the contract integration test validates live responses against that document,
 * and `packages/sdk/src/generated/openapi.ts` is generated from it.
 *
 * Objects are open (extra fields allowed): a contract lists the fields a consumer may depend on;
 * adding a field is compatible, removing or retyping one breaks the test.
 */
import {
  ASSET_CLASSES,
  ORDER_STATUSES,
  ORDER_TYPES,
  RISK_CODES,
  SIDES,
  TIME_IN_FORCE,
  TIMEFRAMES,
} from '@kora/domain';
import { z } from 'zod';

const dec = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal string');
const decOrNull = dec.nullable();
const iso = z.string().min(10);
const uuid = z.string().uuid();

const Role = z.enum(['novice', 'trader', 'quant', 'risk_officer', 'admin', 'auditor']);
const KillSwitchScope = z.enum(['robots', 'robots_cancel', 'robots_cancel_flatten']);
const SessionState = z.enum(['open', 'break', 'closed', 'holiday']);
const AssetClass = z.enum(ASSET_CLASSES);
const OrderSource = z.union([
  z.enum(['manual', 'ai-draft-accepted', 'kill-switch']),
  z.string().regex(/^robot:[0-9a-f-]{36}$/),
]);
const HealthStatus = z.looseObject({ status: z.enum(['up', 'down', 'skipped']) });

export const PublicUserSchema = z.looseObject({
  id: uuid,
  email: z.string(),
  displayName: z.string(),
  roles: z.array(Role),
});

export const HealthSchema = z.looseObject({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  environment: z.enum(['PAPER', 'LIVE']),
  liveTradingEnabled: z.literal(false),
  authProvider: z.enum(['dev', 'keycloak']),
  checks: z.looseObject({ db: HealthStatus, redis: HealthStatus, keycloak: HealthStatus }),
  time: iso,
});

export const LoginResponseSchema = z.union([
  z.looseObject({ status: z.literal('ok'), accessToken: z.string(), user: PublicUserSchema }),
  z.looseObject({
    status: z.enum(['mfa_required', 'mfa_enrollment_required']),
    mfaToken: z.string(),
  }),
]);

export const MeSchema = z.looseObject({
  user: z.looseObject({ id: uuid, email: z.string().nullable(), displayName: z.string() }),
  roles: z.array(Role),
  mfa: z.boolean(),
  preferences: z.looseObject({ viewMode: z.enum(['pro', 'novice']) }),
  capabilities: z.looseObject({
    orderTypes: z.array(z.enum(ORDER_TYPES)),
    robotBuilder: z.boolean(),
    auditReadAll: z.boolean(),
    tradingEnvironment: z.enum(['PAPER', 'LIVE']),
  }),
});

export const AuditEventSchema = z.looseObject({
  id: z.string().regex(/^\d+$/),
  ts: iso,
  actorId: z.string(),
  actorType: z.enum(['user', 'robot', 'ai', 'system']),
  action: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/),
  entity: z.string(),
  entityId: z.string().nullable(),
  payload: z.unknown(),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const AuditListSchema = z.looseObject({
  events: z.array(AuditEventSchema),
  nextBeforeId: z.string().nullable(),
});
export const ChainVerificationSchema = z.looseObject({
  valid: z.boolean(),
  count: z.number().int(),
  firstBrokenId: z.string().nullable(),
  reason: z.enum(['hash_mismatch', 'prev_hash_mismatch', 'id_gap']).nullable(),
  headHash: z.string(),
});

// ---- Market data -------------------------------------------------------------------------------
const SessionInfoSchema = z.looseObject({
  state: SessionState,
  localDate: z.string(),
  localTime: z.string(),
  nextChange: z.string().nullable(),
});
export const InstrumentSchema = z.looseObject({
  symbol: z.string(),
  assetClass: AssetClass,
  venue: z.string(),
  quoteCcy: z.string(),
  tickSize: dec,
  pricePrecision: z.number().int(),
  qtyStep: dec,
  minQty: dec,
  assetClassLabel: z.string(),
  session: SessionInfoSchema.nullable(),
});
export const InstrumentsSchema = z.looseObject({ instruments: z.array(InstrumentSchema) });
export const InstrumentDetailSchema = InstrumentSchema.extend({
  staleAfterMs: z.number().nullable(),
});
export const VenuesSchema = z.looseObject({
  venues: z.array(
    z.looseObject({ mic: z.string(), timezone: z.string(), session: SessionInfoSchema }),
  ),
});
export const CandlesSchema = z.looseObject({
  symbol: z.string(),
  tf: z.enum(TIMEFRAMES),
  simulated: z.boolean(),
  source: z.string(),
  candles: z.array(
    z.looseObject({
      t: z.number(),
      open: dec,
      high: dec,
      low: dec,
      close: dec,
      volume: dec,
      trades: z.number().int(),
    }),
  ),
});
const QuoteSchema = z.looseObject({
  symbol: z.string(),
  bid: dec,
  ask: dec,
  stale: z.boolean(),
  source: z.string(),
  seq: z.number(),
  exchangeTs: z.number(),
  receivedTs: z.number(),
});
export const QuotesSchema = z.looseObject({
  quotes: z.array(
    z.looseObject({ symbol: z.string(), quote: QuoteSchema.nullable(), dayOpen: decOrNull }),
  ),
});
export const MarketStatusSchema = z.looseObject({
  status: z.looseObject({ state: z.string(), ts: z.number() }).nullable(),
  gateway: z.looseObject({
    channels: z.number(),
    subscriptions: z.number(),
    connections: z.number(),
    feedLost: z.boolean(),
  }),
  feedMode: z.enum(['inprocess', 'off']),
});

// ---- Trading -----------------------------------------------------------------------------------
export const OrderSchema = z.looseObject({
  id: uuid,
  accountId: uuid,
  clientOrderId: z.string().nullable(),
  parentOrderId: z.string().nullable(),
  symbol: z.string(),
  side: z.enum(SIDES),
  type: z.enum(ORDER_TYPES),
  qty: dec,
  filledQty: dec,
  avgFillPrice: decOrNull,
  limitPrice: decOrNull,
  stopPrice: decOrNull,
  tif: z.enum(TIME_IN_FORCE),
  reduceOnly: z.boolean(),
  postOnly: z.boolean(),
  source: OrderSource,
  status: z.enum(ORDER_STATUSES),
  rejectCode: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export const OrderListSchema = z.looseObject({ orders: z.array(OrderSchema) });
export const OrderDetailSchema = OrderSchema.extend({ children: z.array(OrderSchema) });
export const PlaceOrderSchema = z.looseObject({
  order: OrderSchema,
  idempotentReplay: z.boolean(),
  legs: z.array(OrderSchema).optional(),
});
export const RiskViolationSchema = z.looseObject({ code: z.enum(RISK_CODES), message: z.string() });
export const PreviewSchema = z.looseObject({
  symbol: z.string(),
  simulated: z.literal(true),
  environment: z.literal('PAPER'),
  instrument: z.looseObject({
    assetClass: AssetClass,
    quoteCcy: z.string(),
    pricePrecision: z.number().int(),
    tickSize: dec,
    qtyStep: dec,
    minQty: dec,
    multiplier: dec,
    feesSimulated: z.boolean(),
  }),
  market: z.looseObject({
    bid: decOrNull,
    ask: decOrNull,
    session: SessionState,
    dataState: z.enum(['ok', 'no_quote', 'stale', 'feed_not_ok']),
    dataReason: z.string().nullable(),
  }),
  novice: z.boolean(),
  preview: z
    .looseObject({
      estimatedPrice: dec,
      currency: z.string(),
      fees: z.looseObject({ commission: dec, spread: dec, fxConversion: dec, total: dec }),
      margin: z.looseObject({
        rate: dec,
        required: dec,
        usedAfter: dec,
        freeAfter: dec,
        equity: dec,
      }),
      lossIfStopHit: z.looseObject({ stopPrice: dec, total: dec }).nullable(),
      confirmation: z.looseObject({ required: z.boolean(), reasons: z.array(z.string()) }),
    })
    .nullable(),
  risk: z.looseObject({ ok: z.boolean(), violations: z.array(RiskViolationSchema) }),
  timings: z.looseObject({ riskMs: z.number(), totalMs: z.number() }),
});
export const PositionSchema = z.looseObject({
  accountId: uuid,
  symbol: z.string(),
  qty: dec,
  avgPrice: dec,
  markPrice: decOrNull,
  unrealizedPnl: decOrNull,
  realizedPnl: dec,
  stale: z.boolean(),
  updatedAt: iso,
});
export const PositionsSchema = z.looseObject({ positions: z.array(PositionSchema) });
export const FillSchema = z.looseObject({
  id: uuid,
  orderId: uuid,
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  qty: dec,
  price: dec,
  slippage: dec,
  commission: dec,
  realizedPnl: dec,
  referencePrice: dec,
  liquidity: z.enum(['taker', 'maker']),
  ts: iso,
});
export const FillsSchema = z.looseObject({ fills: z.array(FillSchema) });
const HaltSchema = z.looseObject({
  halted: z.boolean(),
  scope: KillSwitchScope.nullable(),
  haltedAt: z.string().nullable(),
  reason: z.string().nullable(),
});
export const AccountSchema = z.looseObject({
  id: uuid,
  environment: z.enum(['PAPER', 'LIVE']),
  simulated: z.literal(true),
  baseCurrency: z.string(),
  cash: dec,
  equity: dec,
  unrealizedPnl: dec,
  dayPnl: dec,
  marginUsed: dec,
  marginFree: dec,
  dailyLossLimit: dec,
  openPositions: z.number().int(),
  halt: HaltSchema,
  limits: z.looseObject({}),
  asOf: iso,
});
export const KillSwitchSchema = z.looseObject({
  accepted: z.boolean(),
  scope: KillSwitchScope,
  auditEventId: z.string(),
  engine: z.literal('paper'),
  accountId: uuid,
  halted: z.literal(true),
  alreadyHalted: z.boolean(),
  ordersCancelled: z.number().int(),
  positionsFlattened: z.number().int(),
  durationMs: z.number(),
});
export const KillSwitchStateSchema = z.looseObject({
  accountId: uuid,
  halted: z.boolean(),
  scope: KillSwitchScope.nullable(),
  haltedAt: z.string().nullable(),
  reason: z.string().nullable(),
});
export const ResumeSchema = z.looseObject({ accountId: uuid });

// ---- Appropriateness, strategies, robots, governance ---------------------------------------------
export const QuestionnaireSchema = z.looseObject({
  questionnaire: z.looseObject({
    id: z.string(),
    version: z.number().int(),
    questions: z.array(z.looseObject({ id: z.string() })),
  }),
  status: z.looseObject({
    hasTraderRole: z.boolean(),
    eligible: z.boolean(),
    cooldownUntil: z.string().nullable(),
  }),
});
export const TemplatesSchema = z.looseObject({
  templates: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      riskLevel: z.enum(['lower', 'medium', 'higher']),
      definition: z.looseObject({}),
    }),
  ),
  disclaimer: z.string(),
});
export const StrategiesSchema = z.looseObject({
  strategies: z.array(z.looseObject({ id: uuid, name: z.string() })),
});
export const RobotsSchema = z.looseObject({
  robots: z.array(z.looseObject({ id: uuid, status: z.string() })),
});
export const ValidateStrategySchema = z.looseObject({
  valid: z.boolean(),
  issues: z.array(z.looseObject({ path: z.string(), message: z.string(), severity: z.string() })),
  contentHash: z.string(),
});
export const AlertsSchema = z.looseObject({
  alerts: z.array(z.looseObject({ id: z.string(), kind: z.string(), severity: z.string() })),
});
export const DisclosureSchema = z.looseObject({
  document: z.looseObject({
    id: z.string(),
    version: z.string(),
    locale: z.string(),
    title: z.string(),
    contentHash: z.string(),
    placeholder: z.boolean(),
  }),
});
export const AiStatusSchema = z.looseObject({ available: z.boolean() });
