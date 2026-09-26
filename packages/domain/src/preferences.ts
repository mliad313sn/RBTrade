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
  // Pro terminal (goal 04). Configurable in Settings; the cheat sheet (?) reads the same map.
  ticketBuy: 'B',
  ticketSell: 'S',
  submitOrder: 'Ctrl+Enter',
  focusWatchlist: 'Alt+1',
  focusChart: 'Alt+2',
  focusOrderBook: 'Alt+3',
  focusTicket: 'Alt+4',
  focusBlotter: 'Alt+5',
  cheatSheet: 'Shift+?',
};

/** Human labels for the hotkey ids (Settings and the cheat sheet). */
export const HOTKEY_LABELS: Record<string, string> = {
  killSwitch: 'Kill switch (hold 1.5 s)',
  commandPalette: 'Command palette',
  ticketBuy: 'Ticket: buy side',
  ticketSell: 'Ticket: sell side',
  submitOrder: 'Submit order (review)',
  focusWatchlist: 'Focus watchlist',
  focusChart: 'Focus chart',
  focusOrderBook: 'Focus order book',
  focusTicket: 'Focus order ticket',
  focusBlotter: 'Focus blotter',
  cheatSheet: 'Show hotkeys',
};

export const NUMBER_DENSITIES = ['compact', 'comfortable'] as const;
export const TIME_DISPLAYS = ['utc', 'local'] as const;

/** Pro terminal settings (goal 04). Sound on fills is off by default (no nudges). */
export const TerminalSettingsSchema = z
  .object({
    density: z.enum(NUMBER_DENSITIES),
    timeDisplay: z.enum(TIME_DISPLAYS),
    soundOnFills: z.boolean(),
    /** The user's per-trade risk rule, % of equity; the ticket warns above it. */
    perTradeRiskPct: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a percentage such as 1 or 0.5')
      .refine((v) => Number(v) > 0 && Number(v) <= 100, 'Between 0.01 and 100'),
  })
  .strict();
export type TerminalSettings = z.infer<typeof TerminalSettingsSchema>;

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  density: 'compact',
  timeDisplay: 'utc',
  soundOnFills: false,
  perTradeRiskPct: '1',
};

export const UserPreferencesSchema = z.object({
  viewMode: z.enum(VIEW_MODES),
  theme: z.enum(THEMES),
  colourConvention: z.enum(COLOUR_CONVENTIONS),
  hotkeys: HotkeysSchema,
  terminal: TerminalSettingsSchema,
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const UpdatePreferencesSchema = UserPreferencesSchema.extend({ terminal: TerminalSettingsSchema.partial() }).partial().strict();
export type UpdatePreferences = z.infer<typeof UpdatePreferencesSchema>;

export function defaultPreferences(roles: readonly string[]): UserPreferences {
  const noviceOnly = roles.length > 0 && roles.every((r) => r === 'novice');
  return {
    viewMode: noviceOnly ? 'novice' : 'pro',
    theme: 'system',
    colourConvention: 'blue_orange',
    hotkeys: { ...DEFAULT_HOTKEYS },
    terminal: { ...DEFAULT_TERMINAL_SETTINGS },
  };
}

/** Theme actually rendered: 'system' follows the view mode (Pro = dark, Novice = light). */
export function resolveTheme(prefs: Pick<UserPreferences, 'theme' | 'viewMode'>): 'pro-dark' | 'novice-light' {
  if (prefs.theme !== 'system') return prefs.theme;
  return prefs.viewMode === 'pro' ? 'pro-dark' : 'novice-light';
}
