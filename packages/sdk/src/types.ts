import type {
  AssetClass,
  CalendarEvent,
  FeedStatus,
  InstrumentSpec,
  Quote,
  Region,
  SessionState,
  Timeframe,
  Venue,
  AuditEvent,
  ChainVerification,
  KillSwitchScope,
  OrderType,
  OrderDto,
  FillDto,
  PositionDto,
  PreviewResult,
  RiskViolation,
  RiskLimits,
  ConfirmMode,
  PublicQuestionnaire,
  MarketDataState,
  PlaceOrderRequest,
  PreviewOrderRequest,
  Role,
  UpdatePreferences,
  UserPreferences,
  CurrencyExposure,
  HistoricalVarResult,
  CorrelationResult,
} from '@kora/domain';

export type { UpdatePreferences, UserPreferences };

export interface HealthCheck {
  status: 'up' | 'down' | 'skipped';
  latencyMs?: number;
  reason?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  environment: 'PAPER' | 'LIVE';
  liveTradingEnabled: boolean;
  authProvider: 'dev' | 'keycloak';
  checks: { db: HealthCheck; redis: HealthCheck; keycloak: HealthCheck };
  time: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
}

export type LoginResponse =
  | { status: 'ok'; accessToken: string; user: PublicUser }
  | { status: 'mfa_required' | 'mfa_enrollment_required'; mfaToken: string };

export interface MfaEnrollResponse {
  secret: string;
  otpauthUrl: string;
}

export interface MfaVerifyResponse {
  status: 'ok';
  accessToken: string;
  user: PublicUser;
  enrolled: boolean;
}

export interface Capabilities {
  orderTypes: OrderType[];
  robotBuilder: boolean;
  auditReadAll: boolean;
  tradingEnvironment: 'PAPER' | 'LIVE';
}

export interface MeResponse {
  user: { id: string; email: string | null; displayName: string };
  roles: Role[];
  mfa: boolean;
  preferences: UserPreferences;
  capabilities: Capabilities;
}

export interface KillSwitchResponse {
  accepted: boolean;
  scope: KillSwitchScope;
  label: string;
  auditEventId: string;
  engine: 'paper';
  killSwitchId: string;
  accountId: string;
  halted: true;
  alreadyHalted: boolean;
  robotsHalted: boolean;
  ordersCancelled: number;
  positionsFlattened: number;
  flattenPending: Array<{ symbol: string; orderId: string; reason: string }>;
  durationMs: number;
}

export interface KillSwitchState {
  accountId: string;
  halted: boolean;
  scope: KillSwitchScope | null;
  haltedAt: string | null;
  haltedBy: string | null;
  reason: string | null;
}

export interface AuditListQuery {
  actorId?: string;
  actorType?: AuditEvent['actorType'];
  entity?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  beforeId?: string;
  limit?: number;
}

export interface AuditListResponse {
  events: AuditEvent[];
  nextBeforeId: string | null;
}

export type AuditVerifyResponse = ChainVerification;

// ---- Market data (goal 02) --------------------------------------------------------------------

export interface SessionInfo {
  state: SessionState;
  localDate: string;
  localTime: string;
  nextChange: string | null;
  nextState: SessionState | null;
  timezone?: string;
  source?: 'instrument' | 'venue';
}

export interface InstrumentDto extends InstrumentSpec {
  assetClassLabel: string;
  session: SessionInfo | null;
}

export interface VenueDto extends Venue {
  session: SessionInfo;
}

export interface InstrumentDetail extends InstrumentDto {
  staleAfterMs: number | null;
  venueInfo: (Venue & { session: SessionInfo }) | null;
}

export interface InstrumentsQuery {
  assetClass?: AssetClass;
  venue?: string;
  region?: Region;
  q?: string;
}

export interface CandleDto {
  t: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

export interface CandlesResponse {
  symbol: string;
  tf: Timeframe;
  simulated: boolean;
  source: string;
  candles: CandleDto[];
}

export interface QuotesResponse {
  quotes: Array<{ symbol: string; quote: Quote | null; dayOpen: string | null }>;
}

export interface MarketStatusResponse {
  status: FeedStatus | null;
  gateway: {
    channels: number;
    subscriptions: number;
    messagesIn: number;
    framesOut: number;
    dropped: number;
    slowClosed: number;
    conflated: number;
    feedLost: boolean;
    connections: number;
  };
  feedMode: 'inprocess' | 'off';
}

export interface CalendarResponse {
  source: string;
  simulated: boolean;
  events: CalendarEvent[];
}

// ---- Trading (goal 03) -------------------------------------------------------------------------

export type { OrderDto, FillDto, PositionDto, RiskViolation, PlaceOrderRequest, PreviewOrderRequest };

/** Place/preview body as sent by clients (defaults are applied server-side). */
export type OrderInput = Omit<PlaceOrderRequest, 'tif' | 'reduceOnly' | 'postOnly' | 'source'> &
  Partial<Pick<PlaceOrderRequest, 'tif' | 'reduceOnly' | 'postOnly' | 'source'>>;
export type PreviewInput = Omit<OrderInput, 'clientOrderId'> & { clientOrderId?: string };

export interface PreviewResponse {
  symbol: string;
  simulated: true;
  environment: 'PAPER';
  instrument: {
    assetClass: AssetClass;
    quoteCcy: string;
    pricePrecision: number;
    tickSize: string;
    qtyStep: string;
    minQty: string;
    multiplier: string;
    feeScheduleId: string;
    feesSimulated: boolean;
  };
  market: { bid: string | null; ask: string | null; session: SessionState; dataState: MarketDataState; dataReason: string | null };
  novice: boolean;
  preview: Omit<PreviewResult, 'exact' | 'estimatedPriceExact'> | null;
  risk: { ok: boolean; violations: RiskViolation[] };
  timings: { riskMs: number; totalMs: number };
}

export interface PlaceOrderResponse {
  order: OrderDto;
  idempotentReplay: boolean;
  legs?: OrderDto[];
}

/** 422 body of a risk rejection. */
export interface RiskRejectionBody {
  statusCode: 422;
  error: 'risk_rejected';
  code: string;
  message: string;
  violations: RiskViolation[];
  order?: OrderDto;
}

export interface AccountView {
  id: string;
  environment: 'PAPER' | 'LIVE';
  simulated: true;
  baseCurrency: string;
  marginTier: string;
  status: 'active' | 'disabled';
  startingCash: string;
  cash: string;
  equity: string;
  unrealizedPnl: string;
  dayPnl: string;
  weekPnl: string;
  marginUsed: string;
  marginFree: string;
  marginUsedPct: string;
  grossExposure: string;
  leverage: string;
  dailyLossLimit: string;
  dailyLossUsedPct: string;
  openPositions: number;
  unpriced: string[];
  halt: { halted: boolean; scope: KillSwitchScope | null; haltedAt: string | null; haltedBy: string | null; reason: string | null };
  limits: RiskLimits;
  settings: { confirmMode: ConfirmMode; confirmNotionalAbove: string; confirmLossPctAbove: string };
  asOf: string;
}

export interface AccountSettingsPatch {
  confirmMode?: ConfirmMode;
  confirmNotionalAbove?: string;
  confirmLossPctAbove?: string;
  baseCurrency?: string;
  riskLimits?: Partial<RiskLimits>;
}

export interface OrderDetail extends OrderDto {
  children: OrderDto[];
}

// ---- Appropriateness (B-018) ------------------------------------------------------------------

export interface QuestionnaireResponse {
  questionnaire: PublicQuestionnaire;
  status: {
    hasTraderRole: boolean;
    eligible: boolean;
    cooldownUntil: string | null;
    lastAttempt: { version: number; scorePct: number; passed: boolean; at: string } | null;
  };
}

export type AttemptResponse =
  | { passed: true; scorePct: number; passMarkPct: number; questionnaire: { id: string; version: number }; roleGranted: 'trader'; next: 'sign_in_again'; message: string }
  | { passed: false; scorePct: number; passMarkPct: number; questionnaire: { id: string; version: number }; cooldownUntil: string | null; topicsToReview: string[]; message: string };

// ---- Pro terminal (goal 04) ------------------------------------------------------------------

export interface SavedLayout {
  name: string;
  layout: Record<string, unknown>;
  updatedAt: string;
}

export interface RiskSummary {
  accountId: string;
  currency: string;
  simulated: true;
  source: 'api' | 'quant';
  asOf: string;
  exposure: CurrencyExposure[];
  var: HistoricalVarResult & { pctEquity: string | null; note: string };
  correlation: CorrelationResult;
  dailyLoss: { dayPnl: string; limit: string; usedPct: string };
}
