import type { Timeframe } from '@kora/domain';
import type { ComponentType } from 'react';

import type { TicketDraft } from './store';

/**
 * AI strip slot under the chart (goal 04 leaves it; goal 07 fills it).
 *
 * Feature flag `KORA_AI_STRIP`: `off` (hidden), `placeholder` (default: explains the copilot is not
 * available yet, shows no numbers) or `on` (renders the registered component). The component may
 * only call `prefillTicket` (a draft for a human to review); it has no way to place an order.
 */
export type AiStripMode = 'off' | 'placeholder' | 'on';

export interface AiStripSlotProps {
  symbol: string;
  timeframe: Timeframe;
  /** Opens the ticket with this draft; the user reviews and confirms. Source becomes `ai-draft-accepted`. */
  prefillTicket: (draft: Omit<TicketDraft, 'origin'>) => void;
}

let registered: ComponentType<AiStripSlotProps> | null = null;

/** Goal 07 calls this once (client side) to provide the copilot strip. */
export function registerAiStrip(component: ComponentType<AiStripSlotProps>): void {
  registered = component;
}

export function registeredAiStrip(): ComponentType<AiStripSlotProps> | null {
  return registered;
}

export function parseAiStripMode(v: string | undefined): AiStripMode {
  return v === 'off' || v === 'on' ? v : 'placeholder';
}
