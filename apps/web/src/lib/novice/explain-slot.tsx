'use client';

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';

import type { Locale } from '../i18n';
import type { ExplainMode } from './explain-flag';

/**
 * "Explain this to me" slot for the Novice view (goal 08 leaves it; goal 07 fills it with the
 * copilot in novice mode). No copilot code lives here.
 *
 * Feature flag `KORA_EXPLAIN_THIS`: `off` (default) or `on`. When on and a component is registered,
 * `<ExplainThis>` renders it next to the text it explains. The component receives plain context
 * only: it cannot place orders or change limits (AI suggests, never executes).
 */
export const EXPLAIN_TOPICS = [
  'most_you_could_lose',
  'safety_net',
  'spread_and_fees',
  'borrowing',
  'cooling_off',
  'loss_limits',
  'robot_risk_level',
  'past_results',
  'practice_year',
  'glossary_term',
  'lesson',
] as const;
export type ExplainTopic = (typeof EXPLAIN_TOPICS)[number];

export interface ExplainSlotProps {
  topic: ExplainTopic;
  /** Numbers and ids already on screen (strings), e.g. `{ symbol: 'EURUSD', loss: '16.50', ccy: 'USD' }`. */
  context: Readonly<Record<string, string>>;
  locale: Locale;
  mode: 'novice';
  /** Short visible label from the Novice copy, for the button. */
  label?: string;
}

export { parseExplainMode, type ExplainMode } from './explain-flag';

let registered: ComponentType<ExplainSlotProps> | null = null;
const listeners = new Set<() => void>();

/** Goal 07 calls this once, client side, to provide the novice copilot button. */
export function registerExplainThis(component: ComponentType<ExplainSlotProps> | null): void {
  registered = component;
  for (const l of listeners) l();
}

export function registeredExplainThis(): ComponentType<ExplainSlotProps> | null {
  return registered;
}

const ModeCtx = createContext<ExplainMode>('off');

/** Set once in the Novice shell from the server-side flag. */
export function ExplainModeProvider({
  mode,
  children,
}: {
  mode: ExplainMode;
  children: ReactNode;
}) {
  return <ModeCtx.Provider value={mode}>{children}</ModeCtx.Provider>;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Renders the registered component when the flag is on; otherwise nothing (no placeholder). */
export function ExplainThis(props: Omit<ExplainSlotProps, 'mode'>) {
  const mode = useContext(ModeCtx);
  const Component = useSyncExternalStore(subscribe, registeredExplainThis, () => null);
  if (mode !== 'on' || !Component) return null;
  return (
    <span data-testid={`explain-${props.topic}`} className="inline-flex">
      <Component {...props} mode="novice" />
    </span>
  );
}
