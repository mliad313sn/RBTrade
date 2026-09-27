import { z } from 'zod';

import { GUARDED_LIMIT_FIELDS } from '../novice/limits.js';
import type { Role } from '../roles.js';

/**
 * Four-eyes engine (goal 09). One request/approve workflow for every segregation-of-duties control
 * that is not the goal 06 robot promotion (which keeps its own sign-off table and trigger). The rule
 * is the same everywhere: the person who approves is never the person who requested, enforced by the
 * API and by a database trigger.
 */
export const FOUR_EYES_KINDS = [
  'limit_override',
  'kill_switch_resume',
  'mfa_reset',
  'disclosure_publish',
  // IRTC R4-02: granting an approval-conferring or privileged role (created by PUT /admin/users/:id/roles).
  'role_grant',
] as const;
export type FourEyesKind = (typeof FOUR_EYES_KINDS)[number];

export const FOUR_EYES_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type FourEyesStatus = (typeof FOUR_EYES_STATUSES)[number];

export const FOUR_EYES_LABELS: Record<FourEyesKind, string> = {
  limit_override: 'Loosen a risk limit above the platform default',
  kill_switch_resume: 'Resume trading after a firm halt',
  mfa_reset: 'Reset a user’s two-factor authentication',
  disclosure_publish: 'Publish a disclosure version',
  role_grant: 'Grant a privileged role (admin, risk officer, auditor or trader)',
};

/** Limit fields that may be raised above the platform default for one account (not novice caps). */
export const OVERRIDABLE_LIMIT_FIELDS = GUARDED_LIMIT_FIELDS.filter(
  (f) => f !== 'noviceMaxLeverage' && f !== 'monthlyLossLimit',
);
export type OverridableLimitField = (typeof OVERRIDABLE_LIMIT_FIELDS)[number];

const decimalString = z.string().regex(/^\d{1,15}(\.\d{1,8})?$/, 'a positive decimal string');
const reason = z.string().trim().min(3).max(500);

export const LimitOverrideRequestSchema = z.strictObject({
  kind: z.literal('limit_override'),
  accountId: z.uuid(),
  limits: z
    .partialRecord(
      z.enum(OVERRIDABLE_LIMIT_FIELDS as [OverridableLimitField, ...OverridableLimitField[]]),
      decimalString,
    )
    .refine((l) => Object.keys(l).length > 0, 'at least one limit'),
  reason,
});

export const MfaResetRequestSchema = z.strictObject({
  kind: z.literal('mfa_reset'),
  userId: z.uuid(),
  reason,
});

/**
 * Publishing a drafted disclosure version (`document`) or setting a Compliance value such as the
 * retail-loss figure (`value`, `null` = back to the placeholder). Exactly one of the two.
 */
export const DisclosurePublishRequestSchema = z
  .strictObject({
    kind: z.literal('disclosure_publish'),
    jurisdiction: z.string().regex(/^([A-Z]{2}|GLOBAL)$/),
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
    document: z
      .strictObject({
        disclosureId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        version: z.string().min(1).max(64),
      })
      .optional(),
    value: z
      .strictObject({
        key: z.string().regex(/^[a-zA-Z]{1,64}$/),
        value: z.string().trim().min(1).max(64).nullable(),
      })
      .optional(),
    reason,
  })
  .refine((r) => !!r.document !== !!r.value, 'either a document version or a value');

/** Requests a user can create directly (the kill-switch resume request comes from /kill-switch/resume). */
export const FourEyesCreateSchema = z.discriminatedUnion('kind', [
  LimitOverrideRequestSchema,
  MfaResetRequestSchema,
  DisclosurePublishRequestSchema,
]);
export type FourEyesCreate = z.infer<typeof FourEyesCreateSchema>;

export const FourEyesDecisionSchema = z.strictObject({
  note: z.string().trim().min(3).max(500),
});

/** The rule itself, shared by the service and its tests. */
export function fourEyesViolation(requestedBy: string, decidedBy: string): boolean {
  return requestedBy === decidedBy;
}

/** One of the decider's role rows, as stored in `user_roles`. */
export interface RoleGrantRecord {
  role: Role;
  grantedBy: string | null;
  approvedBy: string | null;
  grantedAt: Date;
}

/**
 * IRTC R4-02: approver independence. A decider may act on a request only through an approval role
 * (`approverRoles`) that was neither granted nor approved by the requester, and that is older than
 * the cooling period. Otherwise one person could create their own approver. Returns null when the
 * decider is independent, or the reason.
 */
export function approverIndependenceIssue(
  grants: readonly RoleGrantRecord[],
  requesterId: string,
  approverRoles: readonly Role[],
  now: Date,
  coolingMs: number,
): 'no_approver_role' | 'granted_by_requester' | 'cooling_period' | null {
  const eligible = grants.filter((g) => approverRoles.includes(g.role));
  if (!eligible.length) return 'no_approver_role';
  const independent = eligible.filter(
    (g) => g.grantedBy !== requesterId && g.approvedBy !== requesterId,
  );
  if (!independent.length) return 'granted_by_requester';
  if (!independent.some((g) => now.getTime() - g.grantedAt.getTime() >= coolingMs))
    return 'cooling_period';
  return null;
}
