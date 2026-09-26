/**
 * Roles and the three lines of defence (goal 09): 1st line `trader`/`quant` (and `novice`), 2nd line
 * `risk_officer`, 3rd line `auditor` (read-only internal audit). `admin` runs operations.
 */
export const ROLES = ['novice', 'trader', 'quant', 'risk_officer', 'admin', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that must pass TOTP MFA on every session (goal 01 scope 2). */
export const MFA_REQUIRED_ROLES: readonly Role[] = [
  'trader',
  'quant',
  'risk_officer',
  'admin',
  'auditor',
];

/** Roles allowed to use the strategy builder (/robots/*). */
export const ROBOT_BUILDER_ROLES: readonly Role[] = ['trader', 'quant', 'admin'];

/**
 * Roles that unlock the Pro tools. An account with none of them is **novice-only**: it is always
 * guarded (goal 03/08 `OmsService.isNovice`, whatever view it is in), and the copilot and market
 * intelligence always answer it in novice mode (goals 07/07B). One definition for all of them.
 */
export const PRO_ROLES: readonly Role[] = ['trader', 'quant', 'risk_officer', 'admin'];

export function isNoviceOnly(roles: readonly Role[]): boolean {
  return !roles.some((r) => PRO_ROLES.includes(r));
}

/**
 * Roles that can read (and act on) every account: the 2nd line and operations. Used for account
 * access, resuming other accounts, reading other users' strategies. Does **not** include `auditor`.
 */
export const AUDIT_READ_ALL_ROLES: readonly Role[] = ['risk_officer', 'admin'];

/** Roles that can read the whole audit log (goal 09: the 3rd line reads it too, read-only). */
export const AUDIT_READ_ROLES: readonly Role[] = ['risk_officer', 'admin', 'auditor'];

/** Governance tooling: control evidence export, retention and control catalogue (2nd + 3rd line). */
export const GOVERNANCE_ROLES: readonly Role[] = ['risk_officer', 'admin', 'auditor'];

/** Approvers in the four-eyes engine (goal 09): 2nd line or operations, never the requester. */
export const APPROVER_ROLES: readonly Role[] = ['risk_officer', 'admin'];

/**
 * Segregation of duties (goal 09): the internal auditor (3rd line) is independent and may not hold a
 * role that operates or controls trading. Returns the conflicting pair, or null.
 */
export const AUDITOR_INCOMPATIBLE_ROLES: readonly Role[] = ['trader', 'quant', 'risk_officer', 'admin'];

export function rolesConflict(roles: readonly Role[]): [Role, Role] | null {
  if (!roles.includes('auditor')) return null;
  const other = roles.find((r) => AUDITOR_INCOMPATIBLE_ROLES.includes(r));
  return other ? ['auditor', other] : null;
}

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
