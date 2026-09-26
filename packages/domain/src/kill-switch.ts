import { z } from 'zod';

/** Master goal: three kill-switch scopes. */
export const KILL_SWITCH_SCOPES = ['robots', 'robots_cancel', 'robots_cancel_flatten'] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

export const KILL_SWITCH_HOLD_MS = 1500;

export const KILL_SWITCH_SCOPE_LABELS: Record<KillSwitchScope, { title: string; detail: string }> =
  {
    robots: {
      title: 'Halt robots',
      detail: 'Stop every running robot. Orders and positions stay.',
    },
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

/** Goal 03: optional free-text reason (audited); same contract otherwise. */
export const KillSwitchRequestWithReasonSchema = KillSwitchRequestSchema.extend({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();
export type KillSwitchRequestWithReason = z.infer<typeof KillSwitchRequestWithReasonSchema>;

export const KillSwitchResumeSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();
export type KillSwitchResume = z.infer<typeof KillSwitchResumeSchema>;

/** Scope rank: a wider scope includes the narrower ones. */
export const KILL_SWITCH_SCOPE_RANK: Record<KillSwitchScope, number> = {
  robots: 1,
  robots_cancel: 2,
  robots_cancel_flatten: 3,
};
