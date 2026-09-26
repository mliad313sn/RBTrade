import { Injectable } from '@nestjs/common';
import { defaultPreferences, type Role, type UpdatePreferences, type UserPreferences } from '@kora/domain';

import { DbService, type Queryable } from '../db/db.service';

interface PrefRow {
  view_mode: UserPreferences['viewMode'];
  theme: UserPreferences['theme'];
  colour_convention: UserPreferences['colourConvention'];
  hotkeys: Record<string, string>;
}

const toPrefs = (r: PrefRow): UserPreferences => ({
  viewMode: r.view_mode,
  theme: r.theme,
  colourConvention: r.colour_convention,
  hotkeys: r.hotkeys,
});

@Injectable()
export class PreferencesRepository {
  constructor(private readonly db: DbService) {}

  async get(userId: string, roles: Role[]): Promise<UserPreferences> {
    const rows = await this.db.query<PrefRow>('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
    const defaults = defaultPreferences(roles);
    if (!rows[0]) return defaults;
    const p = toPrefs(rows[0]);
    return { ...p, hotkeys: { ...defaults.hotkeys, ...p.hotkeys } };
  }

  async update(c: Queryable, userId: string, roles: Role[], patch: UpdatePreferences): Promise<{ before: UserPreferences; after: UserPreferences }> {
    const before = await this.get(userId, roles);
    const after: UserPreferences = { ...before, ...patch, hotkeys: { ...before.hotkeys, ...(patch.hotkeys ?? {}) } };
    await c.query(
      `INSERT INTO user_preferences (user_id, view_mode, theme, colour_convention, hotkeys, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET view_mode = EXCLUDED.view_mode, theme = EXCLUDED.theme,
         colour_convention = EXCLUDED.colour_convention, hotkeys = EXCLUDED.hotkeys, updated_at = now()`,
      [userId, after.viewMode, after.theme, after.colourConvention, JSON.stringify(after.hotkeys)],
    );
    return { before, after };
  }
}
