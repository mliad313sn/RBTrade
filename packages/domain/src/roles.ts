export const ROLES = ['novice', 'trader', 'quant', 'risk_officer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that must pass TOTP MFA on every session (goal 01 scope 2). */
export const MFA_REQUIRED_ROLES: readonly Role[] = ['trader', 'quant', 'risk_officer', 'admin'];

/** Roles allowed to use the strategy builder (/robots/*). */
export const ROBOT_BUILDER_ROLES: readonly Role[] = ['trader', 'quant', 'admin'];

/** Roles that can read the full audit log (others see their own events). */
export const AUDIT_READ_ALL_ROLES: readonly Role[] = ['risk_officer', 'admin'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function requiresMfa(roles: readonly Role[]): boolean {
  return roles.some((r) => MFA_REQUIRED_ROLES.includes(r));
}

export function hasAnyRole(roles: readonly Role[], required: readonly Role[]): boolean {
  return required.length === 0 || roles.some((r) => required.includes(r));
}

/**
 * Sign-up creates `novice` only (Sponsor decision OQ-S2, B-018). `trader` is granted by passing the
 * appropriateness assessment; quant, risk_officer and admin are admin-granted.
 */
export const SELF_SERVICE_ROLES: readonly Role[] = ['novice'];

/** Role granted by passing the appropriateness assessment. */
export const APPROPRIATENESS_GRANTED_ROLE: Role = 'trader';
