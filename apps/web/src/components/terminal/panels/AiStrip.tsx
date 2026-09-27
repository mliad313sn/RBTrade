'use client';

import { registeredAiStrip, type AiStripMode } from '@/lib/terminal/ai-strip';
import { useTerminal } from '@/lib/terminal/store';

/**
 * AI strip slot under the chart (goal 07 fills it). In `placeholder` mode it says what will come
 * and shows no numbers; in `on` mode it renders the component registered with `registerAiStrip`.
 */
export function AiStrip({ mode }: { mode: AiStripMode }) {
  const symbol = useTerminal((s) => s.symbol);
  const timeframe = useTerminal((s) => s.timeframe);
  const prefill = useTerminal((s) => s.prefillTicket);
  const Registered = registeredAiStrip();
  if (mode === 'on' && Registered) {
    return (
      <section className="ai-strip" aria-label="Copilot" data-testid="ai-strip">
        <Registered
          symbol={symbol}
          timeframe={timeframe}
          prefillTicket={(d) => prefill({ ...d, origin: 'ai' })}
        />
      </section>
    );
  }
  return (
    <section
      className="ai-strip"
      aria-label="Copilot (not available yet)"
      data-testid="ai-strip"
      data-mode="placeholder"
    >
      <span className="ai-strip__mark" aria-hidden="true">
        ✦
      </span>
      <span className="ai-strip__label">Copilot</span>
      <span className="ai-strip__text">
        The AI copilot arrives in a later release. It will explain signals with sources and can only
        draft an order for you to review; it never places trades.
      </span>
    </section>
  );
}
