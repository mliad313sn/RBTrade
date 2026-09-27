import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

/**
 * Governance settings (goal 09). None of these is a regulatory value: they are operating choices
 * with conservative defaults. Regulatory figures live in the disclosures registry as placeholders.
 */
const Schema = z.object({
  KORA_ENV: z.enum(['dev', 'test', 'staging', 'production']).default('dev'),
  /**
   * Kill-switch resume policy. `firm`: a halt set by someone other than the account owner (a risk
   * officer, or the global kill switch) needs a second person to resume. `all`: every resume needs
   * four eyes (intended for LIVE accounts).
   */
  KORA_FOUR_EYES_RESUME: z.enum(['firm', 'all']).default('firm'),
  /**
   * IRTC R4-02: an approver role younger than this cannot approve anything (cooling period after a
   * grant). Empty = 24 h outside dev/test, 0 in dev/test.
   */
  KORA_APPROVER_COOLING_HOURS: z.coerce.number().min(0).max(24 * 90).optional(),
  /** Pending four-eyes requests expire after this many hours. */
  KORA_FOUR_EYES_TTL_HOURS: z.coerce.number().min(1).max(24 * 30).default(72),
  /** A running robot is "near auto-pause" at this % of any of its loss/drawdown limits. */
  KORA_RISK_NEAR_PAUSE_PCT: z.coerce.number().min(1).max(100).default(70),
  /** An account is "near its limit" at this % of its daily/weekly loss limit or leverage cap. */
  KORA_RISK_NEAR_LIMIT_PCT: z.coerce.number().min(1).max(100).default(80),
  /** Signed audit anchors (B-007): ES256 private JWK (JSON). Empty = ephemeral key (dev/test only). */
  KORA_AUDIT_ANCHOR_JWK: z.string().default(''),
  /** Directory the anchors are appended to (WORM stand-in). Empty = database only. */
  KORA_AUDIT_ANCHOR_DIR: z.string().default(''),
  /** Interval of the in-process anchoring job (0 = off; daily in production). */
  KORA_AUDIT_ANCHOR_INTERVAL_MS: z.coerce.number().int().min(0).max(7 * 86_400_000).default(0),
  /** Deployment jurisdiction whose disclosures are served (placeholder until OQ-R2). */
  KORA_JURISDICTION: z
    .string()
    .regex(/^([A-Z]{2}|GLOBAL)$/)
    .default('GLOBAL'),
  /** Release record (change management evidence). */
  KORA_BUILD_SHA: z.string().max(64).default(''),
  KORA_RELEASE_APPROVAL_REF: z.string().max(200).default(''),
  KORA_RELEASE_RECORD: bool(true),
  /** Risk console LISTEN/NOTIFY relay of alerts to the WS channel. */
  KORA_ALERT_RELAY: bool(true),
});

export type GovernanceConfig = ReturnType<typeof loadGovernanceConfig>;

export function loadGovernanceConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Schema.parse(env);
  const devLike = e.KORA_ENV === 'dev' || e.KORA_ENV === 'test';
  if (!devLike && !e.KORA_AUDIT_ANCHOR_JWK) {
    throw new Error('KORA_AUDIT_ANCHOR_JWK must be set outside dev/test (signed audit anchors, B-007)');
  }
  return {
    env: e.KORA_ENV,
    resumePolicy: e.KORA_FOUR_EYES_RESUME,
    fourEyesTtlMs: Math.round(e.KORA_FOUR_EYES_TTL_HOURS * 3_600_000),
    approverCoolingMs: Math.round((e.KORA_APPROVER_COOLING_HOURS ?? (devLike ? 0 : 24)) * 3_600_000),
    nearPausePct: e.KORA_RISK_NEAR_PAUSE_PCT,
    nearLimitPct: e.KORA_RISK_NEAR_LIMIT_PCT,
    anchorJwk: e.KORA_AUDIT_ANCHOR_JWK,
    anchorDir: e.KORA_AUDIT_ANCHOR_DIR,
    anchorIntervalMs: e.KORA_AUDIT_ANCHOR_INTERVAL_MS,
    jurisdiction: e.KORA_JURISDICTION,
    buildSha: e.KORA_BUILD_SHA,
    releaseApprovalRef: e.KORA_RELEASE_APPROVAL_REF,
    releaseRecord: e.KORA_RELEASE_RECORD,
    alertRelay: e.KORA_ALERT_RELAY,
  };
}

export const GOVERNANCE_CONFIG = Symbol('GOVERNANCE_CONFIG');
