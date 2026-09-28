import { describe, expect, it } from 'vitest';

import { PRIVILEGED_GRANT_ROLES, ROLE_GRANT_APPROVER_ROLES, APPROVER_ROLES } from '../roles.js';
import { approverIndependenceIssue, FOUR_EYES_KINDS, FOUR_EYES_LABELS } from './four-eyes.js';

const now = new Date('2026-09-27T12:00:00Z');
const day = 86_400_000;
const A = 'requester';

describe('IRTC R4-02 · approver independence', () => {
  it('refuses an approver whose only approval role the requester granted or approved', () => {
    expect(
      approverIndependenceIssue(
        [{ role: 'risk_officer', grantedBy: A, approvedBy: 'x', grantedAt: new Date(0) }],
        A,
        APPROVER_ROLES,
        now,
        0,
      ),
    ).toBe('granted_by_requester');
    expect(
      approverIndependenceIssue(
        [{ role: 'admin', grantedBy: 'x', approvedBy: A, grantedAt: new Date(0) }],
        A,
        APPROVER_ROLES,
        now,
        0,
      ),
    ).toBe('granted_by_requester');
  });

  it('accepts the decider through another, independent approval role', () => {
    expect(
      approverIndependenceIssue(
        [
          { role: 'risk_officer', grantedBy: A, approvedBy: 'x', grantedAt: new Date(0) },
          { role: 'admin', grantedBy: null, approvedBy: null, grantedAt: new Date(0) },
        ],
        A,
        APPROVER_ROLES,
        now,
        day,
      ),
    ).toBeNull();
  });

  it('enforces the cooling period on a fresh approval role', () => {
    const fresh = [
      {
        role: 'risk_officer' as const,
        grantedBy: 'x',
        approvedBy: 'y',
        grantedAt: new Date(now.getTime() - 3_600_000),
      },
    ];
    expect(approverIndependenceIssue(fresh, A, APPROVER_ROLES, now, day)).toBe('cooling_period');
    expect(approverIndependenceIssue(fresh, A, APPROVER_ROLES, now, 0)).toBeNull();
  });

  it('IRTC re-verify R1-02/R4-02: refuses a decider who granted or approved a role of the requester (reverse direction)', () => {
    const D = 'decider';
    const deciderGrants = [
      { role: 'admin' as const, grantedBy: null, approvedBy: null, grantedAt: new Date(0) },
    ];
    // The requester's admin role was requested by the decider (a second admin approved it once).
    expect(
      approverIndependenceIssue(deciderGrants, A, APPROVER_ROLES, now, 0, {
        deciderId: D,
        requesterGrants: [{ role: 'admin', grantedBy: D, approvedBy: 'x', grantedAt: new Date(0) }],
      }),
    ).toBe('requester_granted_by_decider');
    // ... or approved by the decider.
    expect(
      approverIndependenceIssue(deciderGrants, A, APPROVER_ROLES, now, 0, {
        deciderId: D,
        requesterGrants: [
          { role: 'trader', grantedBy: 'x', approvedBy: D, grantedAt: new Date(0) },
        ],
      }),
    ).toBe('requester_granted_by_decider');
    // Unrelated requester rows (self-service or granted by others) keep the decider independent.
    expect(
      approverIndependenceIssue(deciderGrants, A, APPROVER_ROLES, now, 0, {
        deciderId: D,
        requesterGrants: [
          { role: 'trader', grantedBy: null, approvedBy: null, grantedAt: new Date(0) },
          { role: 'admin', grantedBy: 'x', approvedBy: 'y', grantedAt: new Date(0) },
        ],
      }),
    ).toBeNull();
  });

  it('role grants are decided by admins only', () => {
    expect(
      approverIndependenceIssue(
        [{ role: 'risk_officer', grantedBy: null, approvedBy: null, grantedAt: new Date(0) }],
        A,
        ROLE_GRANT_APPROVER_ROLES,
        now,
        0,
      ),
    ).toBe('no_approver_role');
  });

  it('role_grant is a labelled four-eyes kind and every approval-conferring role needs it', () => {
    expect(FOUR_EYES_KINDS).toContain('role_grant');
    expect(FOUR_EYES_LABELS.role_grant).toMatch(/privileged role/);
    for (const r of [...APPROVER_ROLES, 'auditor', 'trader'] as const)
      expect(PRIVILEGED_GRANT_ROLES).toContain(r);
  });
});
