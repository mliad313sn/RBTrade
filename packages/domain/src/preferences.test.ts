import { describe, expect, it } from 'vitest';

import { defaultPreferences, resolveTheme, UpdatePreferencesSchema } from './preferences.js';

describe('preferences', () => {
  it('defaults novice-only users to the novice view', () => {
    expect(defaultPreferences(['novice']).viewMode).toBe('novice');
    expect(defaultPreferences(['trader']).viewMode).toBe('pro');
    expect(defaultPreferences(['novice', 'trader']).viewMode).toBe('pro');
    expect(defaultPreferences([]).colourConvention).toBe('blue_orange');
  });
  it('resolves system theme from view mode', () => {
    expect(resolveTheme({ theme: 'system', viewMode: 'pro' })).toBe('pro-dark');
    expect(resolveTheme({ theme: 'system', viewMode: 'novice' })).toBe('novice-light');
    expect(resolveTheme({ theme: 'pro-dark', viewMode: 'novice' })).toBe('pro-dark');
  });
  it('rejects unknown fields and values', () => {
    expect(UpdatePreferencesSchema.safeParse({ viewMode: 'novice' }).success).toBe(true);
    expect(UpdatePreferencesSchema.safeParse({ viewMode: 'expert' }).success).toBe(false);
    expect(UpdatePreferencesSchema.safeParse({ admin: true }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'X']));
    expect(UpdatePreferencesSchema.safeParse({ hotkeys: many }).success).toBe(false);
  });
});

describe('order types by view mode', () => {
  it('hides advanced order types in novice view', async () => {
    const { orderTypesFor, ADVANCED_ORDER_TYPES } = await import('./types.js');
    expect(orderTypesFor('novice')).toEqual(['market']);
    for (const t of ADVANCED_ORDER_TYPES) {
      expect(orderTypesFor('pro')).toContain(t);
      expect(orderTypesFor('novice')).not.toContain(t);
    }
  });
});
