'use client';

import { KoraApiError, type AttemptResponse, type DisclosureDocument, type QuestionnaireResponse } from '@kora/sdk';
import { Banner, Button, Chip, Panel } from '@kora/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { api } from '@/lib/api-browser';

/**
 * Appropriateness assessment (B-018). Everyone starts as novice; passing unlocks the Pro trader
 * role. Answers are graded on the server and never stored; after a pass the user signs in again
 * and sets up two-factor authentication.
 */
export function Appropriateness() {
  const router = useRouter();
  const [data, setData] = useState<QuestionnaireResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<AttemptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // IRTC R4-09: Pro trading starts only after the risk warning in force is read and confirmed here.
  const [warning, setWarning] = useState<DisclosureDocument | null>(null);
  const [ticked, setTicked] = useState(false);

  useEffect(() => {
    api
      .appropriateness()
      .then(setData)
      .catch(() => setError('The assessment could not be loaded. Try again later.'));
    api
      .disclosure('risk-warning', 'en')
      .then((r) => setWarning(r.document))
      .catch(() => setError('The risk warning could not be loaded. Try again later.'));
  }, []);

  if (error && !data) return <Banner tone="critical" title="Couldn't load.">{error}</Banner>;
  if (!data) return <p className="text-muted">Loading the assessment…</p>;
  const q = data.questionnaire;
  const all = q.questions.every((x) => answers[x.id]) && ticked && !!warning;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!warning) return;
      const r = await api.submitAppropriateness(q.id, q.version, answers, {
        version: warning.version,
        contentHash: warning.contentHash,
        locale: 'en',
      });
      setResult(r);
      if (r.passed) {
        // The session cookie was cleared by the server; the next login sets up two-factor authentication.
        setTimeout(() => {
          router.replace('/login?next=%2Fterminal');
          router.refresh();
        }, 2500);
      }
    } catch (err) {
      setError(err instanceof KoraApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (data.status.hasTraderRole) {
    return (
      <div data-testid="appropriateness-done"><Banner tone="info" title="Pro trading is already unlocked.">
        Your account has the trader role.
      </Banner></div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl" data-testid="appropriateness">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="font-display text-3xl m-0">{q.title}</h1>
        {q.simulated ? (
          <Chip tone="paper" data-testid="appropriateness-simulated">
            SIMULATED questions · pending Compliance review
          </Chip>
        ) : null}
      </div>
      <p className="m-0">{q.intro}</p>
      <p className="m-0 text-sm text-muted">
        Version {q.version} · pass mark {q.passMarkPct}% · after a fail you can try again in {Math.round(q.cooldownMinutes / 60)} hours.
      </p>

      {result ? (
        result.passed ? (
          <div data-testid="appropriateness-result"><Banner tone="info" title={`Passed with ${result.scorePct}%.`}>
            {result.message} Taking you to sign in…
          </Banner></div>
        ) : (
          <div data-testid="appropriateness-result"><Banner tone="warn" title={`Not passed: ${result.scorePct}% (pass mark ${result.passMarkPct}%).`}>
            {result.message}
            {result.topicsToReview.length ? <span className="block mt-1">Review: {result.topicsToReview.join(', ')}.</span> : null}
            {result.cooldownUntil ? <span className="block mt-1">You can try again after {new Date(result.cooldownUntil).toUTCString()}.</span> : null}
          </Banner></div>
        )
      ) : null}
      {data.status.cooldownUntil && !result ? (
        <div data-testid="appropriateness-cooldown"><Banner tone="warn" title="Please wait before trying again.">
          Your last attempt did not pass. You can try again after {new Date(data.status.cooldownUntil).toUTCString()}.
        </Banner></div>
      ) : null}
      {!result && !data.status.eligible && !data.status.cooldownUntil && !data.status.hasTraderRole ? (
        <div data-testid="appropriateness-not-eligible"><Banner tone="info" title="Pro trading cannot be unlocked for this account.">
          One of your roles cannot be combined with trading (segregation of duties). Ask an administrator if this is unexpected.
        </Banner></div>
      ) : null}
      {error ? (
        <Banner tone="critical" title="Couldn't submit.">
          <span data-testid="appropriateness-error">{error}</span>
        </Banner>
      ) : null}

      {!result && data.status.eligible ? (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {q.questions.map((question, i) => (
            <Panel key={question.id}>
              <fieldset className="border-0 p-0 m-0 flex flex-col gap-2" data-testid={`question-${question.id}`}>
                <legend className="font-semibold mb-2">
                  {i + 1}. {question.prompt}
                </legend>
                {question.options.map((o) => (
                  <label key={o.id} className="flex gap-3 items-start cursor-pointer">
                    <input
                      type="radio"
                      name={question.id}
                      value={o.id}
                      checked={answers[question.id] === o.id}
                      onChange={() => setAnswers((a) => ({ ...a, [question.id]: o.id }))}
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </fieldset>
            </Panel>
          ))}
          {warning ? (
            <Panel>
              <div className="flex flex-col gap-2" data-testid="appropriateness-risk-warning">
                <h2 className="font-semibold m-0">{warning.title}</h2>
                <ul className="m-0 pl-5 flex flex-col gap-1">
                  {warning.body.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <p className="m-0 text-xs text-muted">Version {warning.version}</p>
                <label className="flex gap-3 items-start cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ticked}
                    onChange={(e) => setTicked(e.target.checked)}
                    data-testid="appropriateness-risk-ack"
                  />
                  <span className="font-semibold">{warning.acknowledge}</span>
                </label>
              </div>
            </Panel>
          ) : null}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={!all || busy} data-testid="submit-appropriateness">
              Submit answers
            </Button>
            {!all ? <span className="text-sm text-muted">Answer every question and confirm the risk warning to submit.</span> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
