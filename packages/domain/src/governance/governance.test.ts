import { describe, expect, it } from 'vitest';

import {
  canTransitionIncident,
  FourEyesCreateSchema,
  fourEyesViolation,
  incidentPriority,
  needsReview,
  OVERRIDABLE_LIMIT_FIELDS,
  sample,
  seedFrom,
} from './index.js';

describe('four-eyes', () => {
  it('the requester can never be the approver', () => {
    expect(fourEyesViolation('u1', 'u1')).toBe(true);
    expect(fourEyesViolation('u1', 'u2')).toBe(false);
  });
  it('validates limit override requests (decimal strings, overridable fields only, a reason)', () => {
    const ok = FourEyesCreateSchema.safeParse({
      kind: 'limit_override',
      accountId: '8d7b8d6c-6f4b-4b5e-9a57-0e1f3c1d2a3b',
      limits: { maxOrderNotional: '750000' },
      reason: 'Professional client review PRJ-1',
    });
    expect(ok.success).toBe(true);
    const bad = [
      { limits: { maxOrderNotional: 750000 } },
      { limits: { noviceMaxLeverage: '3' } },
      { limits: {} },
      { reason: 'x' },
    ];
    for (const b of bad) {
      expect(
        FourEyesCreateSchema.safeParse({
          kind: 'limit_override',
          accountId: '8d7b8d6c-6f4b-4b5e-9a57-0e1f3c1d2a3b',
          limits: { maxOrderNotional: '750000' },
          reason: 'Professional client review',
          ...b,
        }).success,
      ).toBe(false);
    }
    expect(OVERRIDABLE_LIMIT_FIELDS).not.toContain('noviceMaxLeverage');
  });
});

describe('incidents (ITIL 4)', () => {
  it('priority = impact × urgency', () => {
    expect(incidentPriority('high', 'high')).toBe('P1');
    expect(incidentPriority('high', 'medium')).toBe('P2');
    expect(incidentPriority('medium', 'medium')).toBe('P3');
    expect(incidentPriority('low', 'high')).toBe('P3');
    expect(incidentPriority('low', 'low')).toBe('P4');
  });
  it('follows detect → log → classify → resolve → review', () => {
    expect(canTransitionIncident('logged', 'classified')).toBe(true);
    expect(canTransitionIncident('logged', 'resolved')).toBe(false);
    expect(canTransitionIncident('classified', 'resolved')).toBe(true);
    expect(canTransitionIncident('resolved', 'closed')).toBe(true);
    expect(canTransitionIncident('resolved', 'classified')).toBe(true);
    expect(canTransitionIncident('closed', 'logged')).toBe(false);
    expect(needsReview('P1')).toBe(true);
    expect(needsReview('P3')).toBe(false);
    expect(needsReview(null)).toBe(false);
  });
});

describe('audit sampling', () => {
  const pop = Array.from({ length: 1000 }, (_, i) => `e${i}`);
  it('is reproducible for a seed and distinct', () => {
    const a = sample(pop, 25, seedFrom('audit-2026-Q3'));
    const b = sample(pop, 25, seedFrom('audit-2026-Q3'));
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(25);
    expect(sample(pop, 25, seedFrom('other'))).not.toEqual(a);
  });
  it('caps at the population size and keeps population order', () => {
    expect(sample(['a', 'b', 'c'], 10, 1)).toEqual(['a', 'b', 'c']);
    expect(sample(pop, 0, 1)).toEqual([]);
    const s = sample(pop, 50, 7);
    expect([...s].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)))).toEqual(s);
  });
  it('covers the population roughly uniformly', () => {
    const counts = new Array(10).fill(0);
    for (let seed = 0; seed < 400; seed++) for (const x of sample(pop, 10, seed)) counts[Math.floor(Number(x.slice(1)) / 100)]++;
    for (const c of counts) expect(c).toBeGreaterThan(280);
  });
  it('parses numeric seeds as numbers', () => {
    expect(seedFrom('42')).toBe(42);
    expect(seedFrom('abc')).toBe(seedFrom('abc'));
  });
});
