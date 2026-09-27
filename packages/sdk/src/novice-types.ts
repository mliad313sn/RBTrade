import type {
  CoolingOffReason,
  GuardedLimitField,
  NoviceDirection,
  PreviewOrderRequest,
  PublicQuestionnaire,
  RiskFactor,
  SessionState,
} from '@kora/domain';

import type { PreviewResponse } from './types.js';

/** Goal 08 Novice view wire types (mirror of apps/api/src/novice and apps/api/src/disclosures). */

export interface PendingLimit {
  field: GuardedLimitField;
  value: string;
  requestedAt: string;
  effectiveAt: string;
}

export interface KnowledgeStatus {
  passed: boolean;
  eligible: boolean;
  cooldownUntil: string | null;
  lastAttempt: { version: number; scorePct: number; passed: boolean; at: string } | null;
}

export interface NoviceProfile {
  guarded: boolean;
  currency: string;
  environment: 'PAPER';
  simulated: true;
  onboarding: {
    completed: boolean;
    completedAt: string | null;
    disclosureAcknowledged: boolean;
    limitsSet: boolean;
  };
  suggestedLimits: {
    daily: string;
    monthly: string;
    dailyPct: string;
    monthlyPct: string;
    simulated: true;
  };
  limits: {
    daily: { limit: string; used: string };
    monthly: { limit: string | null; used: string };
    pending: PendingLimit[];
    loosenDelayHours: number;
  };
  coolingOff: {
    active: boolean;
    reason: CoolingOffReason | null;
    losingTradesToday: number;
    dayLossPct: string;
    until: string | null;
  };
  leverage: {
    state: 'off' | 'pending' | 'on';
    current: string;
    max: string;
    effectiveAt: string | null;
    requiresKnowledgeCheck: true;
  };
  knowledgeCheck: KnowledgeStatus;
}

export interface NoviceName {
  en: string;
  fr: string;
}

export interface NoviceHolding {
  symbol: string;
  name: NoviceName | null;
  displayName: string;
  assetClass: string;
  gainsIf: 'up' | 'down';
  value: string | null;
  unrealizedPnl: string | null;
  stale: boolean;
}

export interface NoviceSummary {
  currency: string;
  simulated: true;
  startedAt: string;
  startingBalance: string;
  balance: string;
  changeSinceStart: { amount: string; pct: string };
  worstDip: { amount: string; pct: string; at: string | null };
  series: Array<{ t: string; equity: string }>;
  holdings: NoviceHolding[];
}

export interface NoviceAsset {
  symbol: string;
  rank: number;
  name: NoviceName;
  displayName: string;
  assetClass: string;
  quoteCcy: string;
  venue: { mic: string; name: string; region: string; timezone: string };
  session: SessionState;
  nextChange: string | null;
  priced: boolean;
  dataState: string;
  minAmount: string | null;
}

export interface NoviceTicketRequest {
  symbol: string;
  direction: NoviceDirection;
  amount: string;
  safetyNetPct: string;
}

export type NoviceTicketResponse =
  | {
      ok: true;
      order: PreviewOrderRequest;
      refPrice: string;
      amountUsed: string;
      minAmount: string;
      safetyNetPct: string;
      currency: string;
      preview: PreviewResponse;
      scenario: { loss: string; gain: string } | null;
    }
  | { ok: false; reason: 'amount_too_small' | 'no_price' | 'no_fx'; minAmount: string | null };

export interface KnowledgeCheckResponse {
  questionnaire: PublicQuestionnaire;
  status: KnowledgeStatus;
}

export interface KnowledgeAttemptResponse {
  passed: boolean;
  scorePct: number;
  passMarkPct: number;
  questionnaire: { id: string; version: number };
  cooldownUntil: string | null;
  topicsToReview: string[];
}

export interface OosResult {
  segment: 'out_of_sample';
  runId: string;
  testedAt: string;
  trades: number;
  returnPct: string | null;
  worstDipPct: string | null;
  winRatePct: string | null;
  days: number | null;
  simulated: true;
}

export interface AutoInvestTemplate {
  id: string;
  riskLevel: 1 | 2 | 3 | 4 | 5;
  factors: RiskFactor[];
  symbols: string[];
  timeframe: string;
  oos: OosResult | null;
  robot: {
    id: string;
    status: 'draft' | 'running' | 'paused' | 'stopped';
    allocation: string;
    equity: string;
    pnl: string;
    openPositions: number;
    startedAt: string | null;
    pauseReason: string | null;
    mode: 'PAPER' | 'LIVE';
  } | null;
}

export interface AutoInvestList {
  currency: string;
  environment: 'PAPER';
  simulated: true;
  amount: { min: string; max: string };
  templates: AutoInvestTemplate[];
  liveAvailable: false;
}

export type DisclosureLocale = 'en' | 'fr';

export interface DisclosureDocument {
  id: string;
  version: string;
  locale: DisclosureLocale;
  title: string;
  banner: string;
  body: string[];
  acknowledge: string;
  values: Record<string, string>;
  placeholder: boolean;
  simulated: boolean;
  reviewStatus: string;
  contentHash: string;
}

export interface DisclosureAcknowledgement {
  id: string;
  disclosureId: string;
  version: string;
  contentHash: string;
  locale: DisclosureLocale;
  values: Record<string, string>;
  context: 'onboarding' | 'banner' | 'settings' | 'reconfirm' | 'appropriateness';
  at: string;
}

export interface DisclosureResponse {
  document: DisclosureDocument;
  acknowledged: boolean;
  lastAcknowledgement: DisclosureAcknowledgement | null;
}

export interface MfaOptInResponse {
  mfaToken: string;
  secret: string;
  otpauthUrl: string;
}
