import { describe, expect, it } from 'vitest';

import { hasAnyRole, isRole, requiresMfa, ROBOT_BUILDER_ROLES } from './roles.js';

describe('roles', () => {
  it('requires MFA for every non-novice role', () => {
    expect(requiresMfa(['novice'])).toBe(false);
    expect(requiresMfa([])).toBe(false);
    for (const r of ['trader', 'quant', 'risk_officer', 'admin'] as const) {
      expect(requiresMfa([r])).toBe(true);
      expect(requiresMfa(['novice', r])).toBe(true);
    }
  });
  it('checks role membership', () => {
    expect(hasAnyRole(['novice'], ROBOT_BUILDER_ROLES)).toBe(false);
    expect(hasAnyRole(['quant'], ROBOT_BUILDER_ROLES)).toBe(true);
    expect(hasAnyRole(['novice'], [])).toBe(true);
    expect(isRole('admin')).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isRole(3)).toBe(false);
  });
});
