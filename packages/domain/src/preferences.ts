import { z } from 'zod';

export const VIEW_MODES = ['pro', 'novice'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const THEMES = ['system', 'pro-dark', 'novice-light'] as const;
export type ThemePreference = (typeof THEMES)[number];

export const COLOUR_CONVENTIONS = ['blue_orange', 'green_red', 'red_up_asia'] as const;
export type ColourConvention = (typeof COLOUR_CONVENTIONS)[number];

export const HotkeysSchema = z
  .record(z.string().min(1).max(64), z.string().min(1).max(32))
  .refine((o) => Object.keys(o).length <= 64, 'too many hotkeys');

export const DEFAULT_HOTKEYS: Record<string, string> = {
  killSwitch: 'Ctrl+Shift+K',
  commandPalette: 'Mod+K',
};

export const UserPreferencesSchema = z.object({
  viewMode: z.enum(VIEW_MODES),
  theme: z.enum(THEMES),
  colourConvention: z.enum(COLOUR_CONVENTIONS),
  hotkeys: HotkeysSchema,
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const UpdatePreferencesSchema = UserPreferencesSchema.partial().strict();
export type UpdatePreferences = z.infer<typeof UpdatePreferencesSchema>;

export function defaultPreferences(roles: readonly string[]): UserPreferences {
  const noviceOnly = roles.length > 0 && roles.every((r) => r === 'novice');
  return {
    viewMode: noviceOnly ? 'novice' : 'pro',
    theme: 'system',
    colourConvention: 'blue_orange',
    hotkeys: { ...DEFAULT_HOTKEYS },
  };
}

/** Theme actually rendered: 'system' follows the view mode (Pro = dark, Novice = light). */
export function resolveTheme(prefs: Pick<UserPreferences, 'theme' | 'viewMode'>): 'pro-dark' | 'novice-light' {
  if (prefs.theme !== 'system') return prefs.theme;
  return prefs.viewMode === 'pro' ? 'pro-dark' : 'novice-light';
}
