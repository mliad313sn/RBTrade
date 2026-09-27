'use client';

import { KoraApiError, type AttemptResponse, type QuestionnaireResponse } from '@kora/sdk';
import { Banner, Button, Chip, Panel } from '@kora/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { api } from '@/lib/api-browser';
import { hasKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/react';

/**
 * Appropriateness assessment (B-018). Everyone starts as novice; passing unlocks the Pro trader
 * role. Answers are graded on the server and never stored; after a pass the user signs in again
 * and sets up two-factor authentication.
 *
 * IRTC R5-12: the copy follows the viewer's language (the questions come from the graded data in
 * English; `appr.q.*` holds the French translation, pending Compliance review, OQ-C1), and each answer
 * is a full-width 44 px row. IRTC R5-10: arriving from the Pro switch explains why the check is needed.
 */
export function Appropriateness() {
  const router = useRouter();
  const params = useSearchParams();
  const { t, locale, dateTime } = useI18n();
  const [data, setData] = useState<QuestionnaireResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<AttemptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Translated questionnaire text when a key exists for this exact data (else the data itself). */
  const tr = (key: string, fallback: string) => (locale !== 'en' && hasKey(key) ? t(key) : fallback);

  useEffect(() => {
    api
      .appropriateness()
      .then(setData)
      .catch(() => setError(t('appr.loadError.body')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fromPro =
    params.get('from') === 'pro' ? (
      <div data-testid="pro-needs-assessment">
        <Banner tone="info" title={t('mode.needsAssessment.title')}>
          {t('mode.needsAssessment.body')}
        </Banner>
      </div>
    ) : null;

  if (error && !data)
    return (
      <Banner tone="critical" title={t('appr.loadError.title')}>
        {error}
      </Banner>
    );
  if (!data) return <p className="text-muted">{t('appr.loading')}</p>;
  const q = data.questionnaire;
  const all = q.questions.every((x) => answers[x.id]);
  const topicName = (topic: string) => {
    const id = q.questions.find((x) => x.topic === topic)?.id;
    return id ? tr(`appr.topic.${id}`, topic) : topic;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.submitAppropriateness(q.id, q.version, answers);
      setResult(r);
      if (r.passed) {
        // The session cookie was cleared by the server; the next login sets up two-factor authentication.
        setTimeout(() => {
          router.replace('/login?next=%2Fterminal');
          router.refresh();
        }, 2500);
      }
    } catch (err) {
      setError(err instanceof KoraApiError && locale === 'en' ? err.message : t('appr.submitError.body'));
    } finally {
      setBusy(false);
    }
  }

  if (data.status.hasTraderRole) {
    return (
      <div data-testid="appropriateness-done">
        <Banner tone="info" title={t('appr.done.title')}>
          {t('appr.done.body')}
        </Banner>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl min-w-0" data-testid="appropriateness">
      {fromPro}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="font-display text-3xl m-0 break-words">{tr('appr.q.title', q.title)}</h1>
        {q.simulated ? (
          <Chip tone="paper" data-testid="appropriateness-simulated">
            {t('appr.simulated')}
          </Chip>
        ) : null}
      </div>
      <p className="m-0">{tr('appr.q.intro', q.intro)}</p>
      <p className="m-0 text-sm text-muted">{t('appr.meta', { version: q.version, pass: q.passMarkPct, hours: Math.round(q.cooldownMinutes / 60) })}</p>

      {result ? (
        result.passed ? (
          <div data-testid="appropriateness-result">
            <Banner tone="info" title={t('appr.passed.title', { score: result.scorePct })}>
              {locale === 'en' ? result.message : t('appr.passed.body')} {t('appr.passed.next')}
            </Banner>
          </div>
        ) : (
          <div data-testid="appropriateness-result">
            <Banner tone="warn" title={t('appr.failed.title', { score: result.scorePct, pass: result.passMarkPct })}>
              {locale === 'en' ? result.message : t('appr.failed.body')}
              {result.topicsToReview.length ? <span className="block mt-1">{t('appr.review', { topics: result.topicsToReview.map(topicName).join(', ') })}</span> : null}
              {result.cooldownUntil ? <span className="block mt-1">{t('appr.retryAfter', { when: dateTime(result.cooldownUntil) })}</span> : null}
            </Banner>
          </div>
        )
      ) : null}
      {data.status.cooldownUntil && !result ? (
        <div data-testid="appropriateness-cooldown">
          <Banner tone="warn" title={t('appr.cooldown.title')}>
            {t('appr.cooldown.body', { when: dateTime(data.status.cooldownUntil) })}
          </Banner>
        </div>
      ) : null}
      {error ? (
        <Banner tone="critical" title={t('appr.submitError.title')}>
          <span data-testid="appropriateness-error">{error}</span>
        </Banner>
      ) : null}

      {!result && data.status.eligible ? (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {q.questions.map((question, i) => (
            <Panel key={question.id}>
              <fieldset className="border-0 p-0 m-0 flex flex-col gap-1 min-w-0" data-testid={`question-${question.id}`}>
                <legend className="font-semibold mb-2">
                  {i + 1}. {tr(`appr.q.${question.id}.prompt`, question.prompt)}
                </legend>
                {question.options.map((o) => (
                  // 44 px rows: the whole line is the target, not only the 13 px radio (goal 08 §8).
                  <label key={o.id} className="flex gap-3 items-center cursor-pointer min-h-11 py-1 px-2 -mx-2 rounded hover:bg-raised">
                    <input
                      type="radio"
                      className="w-5 h-5 shrink-0"
                      name={question.id}
                      value={o.id}
                      checked={answers[question.id] === o.id}
                      onChange={() => setAnswers((a) => ({ ...a, [question.id]: o.id }))}
                    />
                    <span>{tr(`appr.q.${question.id}.${o.id}`, o.label)}</span>
                  </label>
                ))}
              </fieldset>
            </Panel>
          ))}
          <div className="flex items-center gap-3 flex-wrap">
            <Button type="submit" variant="primary" disabled={!all || busy} data-testid="submit-appropriateness">
              {t('appr.submit')}
            </Button>
            {!all ? <span className="text-sm text-muted">{t('appr.answerAll')}</span> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
