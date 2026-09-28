import { formatMoney } from '@kora/ui';

/**
 * Order-ticket preview helpers (IRTC R5-01, R5-05).
 *
 * - The *request key* is the exact JSON body sent to POST /orders/preview and POST /orders. A preview
 *   is only ever used to confirm an order whose body has the same key.
 * - The *input key* covers what the user typed or chose (not the market): with a stop in pips or % the
 *   request changes on every tick while the input key stays put. A preview whose input key differs
 *   from the current one is for an older edit and is shown as "updating".
 */

export function requestKey(body: Record<string, unknown> | null): string | null {
  return body ? JSON.stringify(body) : null;
}

export function inputKey(inputs: Record<string, unknown>): string {
  return JSON.stringify(inputs);
}

export interface PreviewFigures {
  currency: string;
  margin: { required: string };
  fees: { total: string };
  lossIfStopHit: { total: string } | null;
}

/** Short spoken summary of a settled preview ("Loss if stop hit 150.00 USD, margin 32,523.00 USD, fees 3.20 USD."). */
export function previewSummary(p: PreviewFigures | null, violations: number): string {
  if (!p) return '';
  const loss = p.lossIfStopHit
    ? `Loss if stop hit ${formatMoney(p.lossIfStopHit.total, p.currency)}`
    : 'No stop: loss not capped';
  const risk = violations ? ` ${violations} risk check${violations === 1 ? '' : 's'} failed.` : '';
  return `${loss}, margin ${formatMoney(p.margin.required, p.currency)}, fees ${formatMoney(p.fees.total, p.currency)}.${risk}`;
}

/**
 * Screen-reader announcements for the ticket preview: one short message per *settled user edit*,
 * never on tick-driven re-previews. `offer(key, text)` is called on every preview; a message is
 * emitted `delayMs` after the last offer for a key that has not been announced yet, and only if the
 * key did not change in between. The same key is never announced twice.
 */
export class SettledAnnouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingKey: string | null = null;
  private pendingText = '';
  private lastAnnounced: string | null = null;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly delayMs = 1000,
  ) {}

  offer(key: string | null, text: string): void {
    if (!key || !text || key === this.lastAnnounced) {
      // Tick-driven refresh of an already announced edit, or nothing to say: stay silent.
      if (key !== this.pendingKey) this.clear();
      return;
    }
    this.pendingText = text;
    if (key === this.pendingKey && this.timer) return; // keep the original deadline for this edit
    this.clear();
    this.pendingKey = key;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastAnnounced = this.pendingKey;
      this.pendingKey = null;
      this.emit(this.pendingText);
    }, this.delayMs);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingKey = null;
  }
}

/**
 * Accessible description of the hold-to-place button (IRTC re-verify RV-02): it states the server's
 * reasons for asking (threshold, no stop loss, …). It used to say "above your confirmation
 * threshold" for every market order, including small orders confirmed only for a missing stop.
 */
export function confirmHoldDescription(reasons: readonly string[]): string {
  return reasons.length
    ? `Market order. Confirmation needed: ${reasons.join(' ')}`
    : 'Market order. Review the figures before placing it.';
}
