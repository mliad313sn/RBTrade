import { Injectable } from '@nestjs/common';
import {
  defaultPreferences,
  TerminalSettingsSchema,
  type Role,
  type UpdatePreferences,
  type UserPreferences,
} from '@kora/domain';

import { DbService, type Queryable } from '../db/db.service';

interface PrefRow {
  view_mode: UserPreferences['viewMode'];
  theme: UserPreferences['theme'];
  colour_convention: UserPreferences['colourConvention'];
  hotkeys: Record<string, string>;
  terminal: Record<string, unknown> | null;
}

const toPrefs = (r: PrefRow, defaults: UserPreferences): UserPreferences => {
  // Stored terminal settings merge over the defaults; an invalid stored value falls back to them.
  const merged = TerminalSettingsSchema.safeParse({ ...defaults.terminal, ...(r.terminal ?? {}) });
  return {
    viewMode: r.view_mode,
    theme: r.theme,
    colourConvention: r.colour_convention,
    hotkeys: { ...defaults.hotkeys, ...r.hotkeys },
    terminal: merged.success ? merged.data : defaults.terminal,
  };
};

@Injectable()
export class PreferencesRepository {
  constructor(private readonly db: DbService) {}

  async get(userId: string, roles: Role[]): Promise<UserPreferences> {
    const rows = await this.db.query<PrefRow>('SELECT * FROM user_preferences WHERE user_id = $1', [
      userId,
    ]);
    const defaults = defaultPreferences(roles);
    if (!rows[0]) return defaults;
    return toPrefs(rows[0], defaults);
  }

  /**
   * Read-modify-write under a row lock, inside the caller's transaction. IRTC R6 (flake "density
   * persist"): two quick saves (time display, then density) used to read the same old row and the
   * second write dropped the first change. The row is created with the defaults when missing, then
   * locked, so concurrent partial updates apply one after the other.
   */
  async update(
    c: Queryable,
    userId: string,
    roles: Role[],
    patch: UpdatePreferences,
  ): Promise<{ before: UserPreferences; after: UserPreferences }> {
    const defaults = defaultPreferences(roles);
    await c.query(
      `INSERT INTO user_preferences (user_id, view_mode, theme, colour_convention, hotkeys, terminal, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now()) ON CONFLICT (user_id) DO NOTHING`,
      [
        userId,
        defaults.viewMode,
        defaults.theme,
        defaults.colourConvention,
        JSON.stringify(defaults.hotkeys),
        JSON.stringify(defaults.terminal),
      ],
    );
    const locked = await c.query<PrefRow>(
      'SELECT * FROM user_preferences WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const before = toPrefs(locked.rows[0]!, defaults);
    const after: UserPreferences = {
      ...before,
      ...patch,
      hotkeys: { ...before.hotkeys, ...(patch.hotkeys ?? {}) },
      terminal: TerminalSettingsSchema.parse({ ...before.terminal, ...(patch.terminal ?? {}) }),
    };
    await c.query(
      `INSERT INTO user_preferences (user_id, view_mode, theme, colour_convention, hotkeys, terminal, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET view_mode = EXCLUDED.view_mode, theme = EXCLUDED.theme,
         colour_convention = EXCLUDED.colour_convention, hotkeys = EXCLUDED.hotkeys, terminal = EXCLUDED.terminal, updated_at = now()`,
      [
        userId,
        after.viewMode,
        after.theme,
        after.colourConvention,
        JSON.stringify(after.hotkeys),
        JSON.stringify(after.terminal),
      ],
    );
    return { before, after };
  }
}
