'use client';

import './ai.css';

import { Button } from '@kora/ui';
import { useId, useState } from 'react';

import { aiApi, type AiContext } from '@/lib/ai/client';

export interface ExplainThisProps {
  /** What to explain, in a few words (e.g. "stop loss", "this chart"). */
  topic: string;
  /** Optional visible text from the screen; sent as untrusted data, never as instructions. */
  screenText?: string;
  context?: AiContext;
  label?: string;
  /** Localised copy from the caller (goal 08 i18n); English defaults. */
  busyLabel?: string;
  failedText?: string;
  /** Short line shown under the answer (e.g. that the answer is in English). */
  note?: string;
}

/**
 * Novice "Explain this to me" (goal 07 §5, placed by goal 08): a plain-language explanation
 * (readability grade 8 or below, checked on the server) with no trade suggestions and no drafts.
 */
export function ExplainThis({
  topic,
  screenText,
  context,
  label = 'Explain this to me',
  busyLabel = 'Explaining…',
  failedText = 'The explainer is not available right now.',
  note,
}: ExplainThisProps) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function explain() {
    if (text) {
      setText(null);
      return;
    }
    setBusy(true);
    try {
      const a = await aiApi.explain({ topic, screenText, context });
      setText(a.status === 'ok' ? a.answer : a.message);
    } catch {
      setText(failedText);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-explain" data-testid="explain-this">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void explain()}
        aria-expanded={text !== null}
        aria-controls={id}
        disabled={busy}
      >
        <span aria-hidden="true">✦ </span>
        {busy ? busyLabel : label}
      </Button>
      {text !== null ? (
        <div
          id={id}
          className="ai-explain__text"
          role="note"
          aria-live="polite"
          data-testid="explain-this-text"
        >
          {text.split('\n').map((l, i) => (l.trim() ? <p key={i}>{l}</p> : null))}
          {note ? <p className="ai-explain__note">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
