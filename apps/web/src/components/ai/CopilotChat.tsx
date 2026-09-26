'use client';

import './ai.css';

import { Button } from '@kora/ui';
import { useRef, useState, type FormEvent } from 'react';

import { aiApi, type AiAnswer, type AiContext, type DraftRef } from '@/lib/ai/client';

export interface CopilotChatProps {
  /** The focused panel and what it shows: sent as context with every question. */
  context: AiContext;
  surface?: 'chat' | 'robots';
  placeholder?: string;
  /** Called when the answer carries an order draft (e.g. to open it in the ticket). */
  onOrderDraft?: (draft: DraftRef) => void;
  onStrategyDraft?: (draft: DraftRef) => void;
  compact?: boolean;
}

/** Streaming copilot chat with the focused panel as context. Suggests and drafts; never executes. */
export function CopilotChat({
  context,
  surface = 'chat',
  placeholder = 'Ask the copilot…',
  onOrderDraft,
  onStrategyDraft,
  compact,
}: CopilotChatProps) {
  const [question, setQuestion] = useState('');
  const [streamed, setStreamed] = useState('');
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  async function ask(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setStreamed('');
    setAnswer(null);
    try {
      const a = await aiApi.chat(
        { message: q, context, surface },
        (d) => setStreamed((s) => s + d),
        ctrl.signal,
      );
      setAnswer(a);
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        setAnswer({
          status: 'error',
          message: (err as Error).message || 'The copilot could not answer.',
        });
    } finally {
      setBusy(false);
    }
  }

  const final = answer?.status === 'ok' ? answer.answer : null;
  const shown: string = final ?? (answer && answer.status !== 'ok' ? answer.message : streamed);
  return (
    <div className={compact ? 'ai-chat ai-chat--compact' : 'ai-chat'} data-testid="copilot-chat">
      <form onSubmit={ask} className="ai-chat__form">
        <label className="k-sr-only" htmlFor={`ai-q-${surface}`}>
          Ask the copilot
        </label>
        <input
          id={`ai-q-${surface}`}
          className="k-input ai-chat__input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={placeholder}
          maxLength={2000}
          data-testid="copilot-input"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || !question.trim()}
          data-testid="copilot-ask"
        >
          {busy ? 'Thinking…' : 'Ask'}
        </Button>
      </form>
      {shown ? (
        <div
          className="ai-chat__answer"
          aria-live="polite"
          data-testid="copilot-answer"
          data-status={answer?.status ?? 'streaming'}
        >
          {shown.split('\n').map((line, i) => (line.trim() ? <p key={i}>{line}</p> : null))}
          {answer?.status === 'ok' && answer.flags.ungrounded.length ? (
            <p className="ai-chat__warn">
              Some figures could not be verified against KORA data and were removed.
            </p>
          ) : null}
          {answer?.status === 'ok'
            ? answer.drafts.map((d) => (
                <div key={d.id} className="ai-chat__draft" data-testid={`copilot-draft-${d.kind}`}>
                  <span>
                    ✦ Draft ready ({d.kind === 'order' ? 'order ticket' : 'strategy change'}) ·
                    review before using
                  </span>
                  {d.kind === 'order' && onOrderDraft ? (
                    <Button size="sm" variant="ghost" onClick={() => onOrderDraft(d)}>
                      Open in ticket
                    </Button>
                  ) : null}
                  {d.kind === 'strategy' && onStrategyDraft ? (
                    <Button size="sm" variant="ghost" onClick={() => onStrategyDraft(d)}>
                      Review draft
                    </Button>
                  ) : null}
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}
