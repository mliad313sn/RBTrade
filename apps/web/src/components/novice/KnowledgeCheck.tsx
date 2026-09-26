'use client';

import {
  KoraApiError,
  type KnowledgeAttemptResponse,
  type KnowledgeCheckResponse,
} from '@kora/sdk';
import { Banner, Button } from '@kora/ui';
import Link from 'next/link';
import { useState } from 'react';

import { api } from '@/lib/api-browser';
import { hasKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/react';

/**
 * The 5-question knowledge check (goal 08 §4, questionnaire engine kind `knowledge_check`). The
 * server grades the answers (pass mark 4/5) and never stores them; French text overlays the graded
 * English by question and option id.
 */
export function KnowledgeCheck({ initial }: { initial: KnowledgeCheckResponse | null }) {
  const { t, dateTime } = useI18n();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<KnowledgeAttemptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!initial) return <p>{t('common.error')}</p>;
  const q = initial.questionnaire;
  const status = initial.status;
  const tx = (key: string, fallback: string) => (hasKey(key) ? t(key) : fallback);
  const allAnswered = q.questions.every((x) => answers[x.id]);

  const submit = async () => {
    if (!allAnswered) return setError(t('kc.answerAll'));
    setBusy(true);
    setError(null);
    try {
      setResult(await api.submitKnowledgeCheck(q.id, q.version, answers));
    } catch (e) {
      if (e instanceof KoraApiError && e.code === 'cooldown')
        setError(
          t('kc.cooldown', { time: dateTime((e.body as { cooldownUntil: string }).cooldownUntil) }),
        );
      else if (e instanceof KoraApiError && e.code === 'already_passed') setError(t('kc.already'));
      else setError(t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-4" data-testid="knowledge-check">
      <h1 className="font-display text-3xl m-0">{t('kc.title')}</h1>
      <p className="m-0 text-lg">{t('kc.intro')}</p>
      {q.simulated ? <p className="m-0 text-sm text-muted">{t('kc.simulated')}</p> : null}
      {status.passed || result?.passed ? (
        <Banner
          tone="info"
          title={result ? t('kc.passed', { pct: result.scorePct }) : t('kc.already')}
        >
          {t('kc.passedNext')}{' '}
          <Link href="/home" className="text-accent font-semibold">
            {t('nav.home')}
          </Link>
        </Banner>
      ) : status.cooldownUntil && !result ? (
        <Banner tone="info">{t('kc.cooldown', { time: dateTime(status.cooldownUntil) })}</Banner>
      ) : (
        <>
          {q.questions.map((question, i) => (
            <fieldset key={question.id} className="k-panel m-0" data-testid={`kc-${question.id}`}>
              <div className="k-panel__body">
                <legend className="font-semibold text-lg mb-2">
                  {i + 1}. {tx(`kc.q.${question.id}.prompt`, question.prompt)}
                </legend>
                <div className="flex flex-col gap-2">
                  {question.options.map((o) => (
                    <label
                      key={o.id}
                      className="flex items-start gap-3 min-h-11 p-2 rounded-lg border border-border cursor-pointer"
                    >
                      <input
                        type="radio"
                        name={question.id}
                        value={o.id}
                        checked={answers[question.id] === o.id}
                        onChange={() => setAnswers((a) => ({ ...a, [question.id]: o.id }))}
                        className="w-5 h-5 mt-0.5 accent-[var(--k-accent)] shrink-0"
                      />
                      <span>{tx(`kc.q.${question.id}.${o.id}`, o.label)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </fieldset>
          ))}
          {result && !result.passed ? (
            <Banner
              tone="warn"
              title={t('kc.failed', { pct: result.scorePct, pass: result.passMarkPct })}
            >
              {t('kc.review')} {result.topicsToReview.map((x) => tx(`kc.topic.${x}`, x)).join(', ')}
              .{' '}
              {result.cooldownUntil
                ? t('kc.cooldown', { time: dateTime(result.cooldownUntil) })
                : null}
            </Banner>
          ) : null}
          {error ? (
            <p className="k-error m-0" role="alert">
              {error}
            </p>
          ) : null}
          {!result ? (
            <Button
              variant="primary"
              size="lg"
              disabled={busy}
              onClick={() => void submit()}
              data-testid="kc-submit"
            >
              {t('kc.submit')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
