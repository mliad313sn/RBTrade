import { z } from 'zod';

/** Master goal: three kill-switch scopes. */
export const KILL_SWITCH_SCOPES = ['robots', 'robots_cancel', 'robots_cancel_flatten'] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

export const KILL_SWITCH_HOLD_MS = 1500;

export const KILL_SWITCH_SCOPE_LABELS: Record<KillSwitchScope, { title: string; detail: string }> = {
  robots: { title: 'Halt robots', detail: 'Stop every running robot. Orders and positions stay.' },
  robots_cancel: {
    title: 'Halt robots + cancel orders',
    detail: 'Stop robots and cancel every working order.',
  },
  robots_cancel_flatten: {
    title: 'Halt, cancel + flatten',
    detail: 'Stop robots, cancel orders and close every open position at market.',
  },
};

export const KillSwitchRequestSchema = z
  .object({
    scope: z.enum(KILL_SWITCH_SCOPES),
    source: z.enum(['ui_button', 'hotkey', 'rest_fallback']).default('ui_button'),
  })
  .strict();
export type KillSwitchRequest = z.infer<typeof KillSwitchRequestSchema>;
