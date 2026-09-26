/**
 * Server-safe part of the "Explain this to me" slot contract (see explain-slot.tsx): the feature
 * flag `KORA_EXPLAIN_THIS` (`off` by default, `on` shows a component registered by goal 07).
 */
export type ExplainMode = 'off' | 'on';

export function parseExplainMode(v: string | undefined): ExplainMode {
  return v === 'on' ? 'on' : 'off';
}
