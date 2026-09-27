/**
 * AI copilot configuration, read from env only. There is deliberately **no default model id**:
 * with `KORA_AI_MODEL` unset the anthropic provider is unavailable and the copilot fails closed
 * with a friendly message (master goal: never hard-code a model id).
 */
export type AiProviderKind = 'anthropic' | 'scripted' | 'replay';
export type ScriptPersona = 'reference' | 'adversarial';

export interface AiConfig {
  provider: AiProviderKind;
  /** From KORA_AI_MODEL; null when unset. */
  model: string | null;
  apiKeyPresent: boolean;
  persona: ScriptPersona;
  replayDir: string | null;
  recordDir: string | null;
  /** `adaptive` sends `thinking: {type: 'adaptive'}`; `omit` leaves the parameter out. */
  thinking: 'adaptive' | 'omit';
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  maxTokens: number;
  maxToolRounds: number;
  userDailyTokens: number;
  orgDailyTokens: number;
  ratePerMin: number;
  cacheTtlSeconds: number;
  orgId: string;
  calibrationMinN: number;
  draftRiskPct: number;
  /** USD per million tokens; used only for the cost metric. 0 when unset (cost shown as unknown). */
  prices: { input: number; output: number; cacheRead: number; cacheWrite: number };
  env: string;
  /** IRTC R4-11: outside dev/test a secret pseudonym salt is required (the default is public). */
  pseudonymSaltMissing: boolean;
}

function num(v: string | undefined, dflt: number, min = 0): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= min ? n : dflt;
}

export function loadAiConfig(e: NodeJS.ProcessEnv = process.env): AiConfig {
  const env = e.KORA_ENV ?? 'dev';
  // IRTC R4-12: either variable saying production makes this a production process.
  const devOrTest = (env === 'dev' || env === 'test') && e.NODE_ENV !== 'production';
  const raw = (e.KORA_AI_PROVIDER ?? 'anthropic').trim();
  let provider: AiProviderKind = raw === 'scripted' || raw === 'replay' ? raw : 'anthropic';
  // Test doubles never serve real users: outside dev/test the provider is always the real one.
  if (!devOrTest) provider = 'anthropic';
  const model = e.KORA_AI_MODEL?.trim() || null;
  const effort = e.KORA_AI_EFFORT?.trim();
  return {
    provider,
    model,
    apiKeyPresent: !!(e.ANTHROPIC_API_KEY?.trim() || e.ANTHROPIC_AUTH_TOKEN?.trim()),
    persona: e.KORA_AI_SCRIPT_PERSONA === 'adversarial' ? 'adversarial' : 'reference',
    replayDir: e.KORA_AI_REPLAY_DIR?.trim() || null,
    recordDir: e.KORA_AI_RECORD_DIR?.trim() || null,
    thinking: e.KORA_AI_THINKING === 'omit' ? 'omit' : 'adaptive',
    effort:
      effort === 'low' ||
      effort === 'medium' ||
      effort === 'high' ||
      effort === 'xhigh' ||
      effort === 'max'
        ? effort
        : null,
    maxTokens: Math.floor(num(e.KORA_AI_MAX_TOKENS, 4096, 256)),
    maxToolRounds: Math.floor(num(e.KORA_AI_MAX_TOOL_ROUNDS, 6, 1)),
    userDailyTokens: Math.floor(num(e.KORA_AI_USER_DAILY_TOKENS, 200_000, 0)),
    orgDailyTokens: Math.floor(num(e.KORA_AI_ORG_DAILY_TOKENS, 5_000_000, 0)),
    ratePerMin: Math.floor(num(e.KORA_AI_RATE_PER_MIN, 20, 1)),
    cacheTtlSeconds: Math.floor(num(e.KORA_AI_CACHE_TTL_S, 300, 0)),
    orgId: e.KORA_AI_ORG_ID?.trim() || 'default',
    calibrationMinN: Math.floor(num(e.KORA_AI_CALIBRATION_MIN_N, 30, 1)),
    draftRiskPct: num(e.KORA_AI_DRAFT_RISK_PCT, 0.5, 0.01),
    prices: {
      input: num(e.KORA_AI_PRICE_INPUT_USD_PER_MTOK, 0),
      output: num(e.KORA_AI_PRICE_OUTPUT_USD_PER_MTOK, 0),
      cacheRead: num(e.KORA_AI_PRICE_CACHE_READ_USD_PER_MTOK, 0),
      cacheWrite: num(e.KORA_AI_PRICE_CACHE_WRITE_USD_PER_MTOK, 0),
    },
    env,
    pseudonymSaltMissing: !devOrTest && (e.KORA_AI_PSEUDONYM_SALT?.trim().length ?? 0) < 16,
  };
}

/** Why the copilot cannot answer right now, or null when it can. */
export function unavailableReason(c: AiConfig): string | null {
  if (c.provider !== 'anthropic') return null;
  if (!c.model) return 'no model is configured (KORA_AI_MODEL is not set)';
  if (!c.apiKeyPresent) return 'no API key is configured';
  if (c.pseudonymSaltMissing)
    return 'KORA_AI_PSEUDONYM_SALT is not set (a secret of 16+ characters is required outside dev/test)';
  return null;
}

export const UNAVAILABLE_MESSAGE =
  'Copilot unavailable: the AI service is not configured on this server. Charts, previews and all trading work as normal.';
