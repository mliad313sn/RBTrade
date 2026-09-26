import { describe, expect, it } from 'vitest';

import { KILL_SWITCH_HOLD_MS, KILL_SWITCH_SCOPE_LABELS, KILL_SWITCH_SCOPES, KillSwitchRequestSchema } from './kill-switch.js';

describe('kill switch contract', () => {
  it('has exactly three scopes with labels and a 1.5 s hold', () => {
    expect(KILL_SWITCH_SCOPES).toHaveLength(3);
    for (const s of KILL_SWITCH_SCOPES) expect(KILL_SWITCH_SCOPE_LABELS[s].title).toBeTruthy();
    expect(KILL_SWITCH_HOLD_MS).toBe(1500);
  });
  it('validates requests', () => {
    expect(KillSwitchRequestSchema.parse({ scope: 'robots' }).source).toBe('ui_button');
    expect(KillSwitchRequestSchema.safeParse({ scope: 'everything' }).success).toBe(false);
    expect(KillSwitchRequestSchema.safeParse({ scope: 'robots', extra: 1 }).success).toBe(false);
  });
});
