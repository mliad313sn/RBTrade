'use client';

import { KoraApiError, type DisclosureDocument, type NoviceProfile } from '@kora/sdk';
import { Button, NumberInput } from '@kora/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api-browser';
import type { MessageKey } from '@/lib/i18n';
import { Rich, useI18n } from '@/lib/i18n/react';
import { ExplainThis } from '@/lib/novice/explain-slot';

const SCREENS: Array<{ title: MessageKey; body: MessageKey; art: string }> = [
  { title: 'onb.s1.title', body: 'onb.s1.body', art: '↗' },
  { title: 'onb.s2.title', body: 'onb.s2.body', art: '⇄' },
  { title: 'onb.s3.title', body: 'onb.s3.body', art: '⛉' },
  { title: 'onb.s4.title', body: 'onb.s4.body', art: '⚖' },
  { title: 'onb.s5.title', body: 'onb.s5.body', art: '☂' },
];
const TOTAL = SCREENS.length + 2;

/**
 * Onboarding (goal 08 §1): five short screens, then the regulatory risk warning (versioned, with the
 * Compliance figure) acknowledged, then daily and monthly loss limits with suggested defaults. The
 * practice account already exists (created on first use).
 */
export function Onboarding({
  profile,
  disclosure: initialDoc,
  startingBalance,
}: {
  profile: NoviceProfile;
  disclosure: DisclosureDocument | null;
  startingBalance: string | null;
}) {
  const { t, locale, money } = useI18n();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [doc, setDoc] = useState(initialDoc);
  const [acked, setAcked] = useState(profile.onboarding.disclosureAcknowledged);
  const [ticked, setTicked] = useState(false);
  const [stale, setStale] = useState(false);
  const [daily, setDaily] = useState(profile.suggestedLimits.daily);
  const [monthly, setMonthly] = useState(profile.suggestedLimits.monthly);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const ccy = profile.currency;

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const acknowledge = async () => {
    if (!doc) return;
    setBusy(true);
    setStale(false);
    try {
      await api.acknowledgeDisclosure(doc.id, {
        version: doc.version,
        contentHash: doc.contentHash,
        locale: doc.locale,
        context: 'onboarding',
      });
      setAcked(true);
      setStep(SCREENS.length + 1);
    } catch (e) {
      if (e instanceof KoraApiError && e.status === 409) {
        setStale(true);
        setTicked(false);
        setDoc((await api.disclosure(doc.id, locale)).document);
      } else setError(t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setError(null);
    if (!(Number(daily) > 0) || !(Number(monthly) > 0)) return setError(t('limits.invalid'));
    if (Number(monthly) < Number(daily)) return setError(t('limits.monthlyLow'));
    setBusy(true);
    try {
      await api.setNoviceLimits({ dailyLossLimit: daily, monthlyLossLimit: monthly });
      await api.completeOnboarding();
      router.replace('/home');
      router.refresh();
    } catch {
      setError(t('common.error'));
      setBusy(false);
    }
  };

  const screen = step < SCREENS.length ? SCREENS[step]! : null;
  return (
    <div className="max-w-xl mx-auto" data-testid="onboarding">
      <p className="m-0 text-sm text-muted" data-testid="onboarding-step">
        {t('onb.progress', { n: step + 1, total: TOTAL })}
      </p>
      <div className="flex gap-1 mt-2 mb-5" aria-hidden="true">
        {Array.from({ length: TOTAL }, (_, i) => (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-border'}`}
          />
        ))}
      </div>
      <section className="k-panel">
        <div className="k-panel__body flex flex-col gap-4">
          {step === 0 ? (
            <p className="m-0 text-sm text-muted" data-testid="practice-account-ready">
              {t('onb.title')} ·{' '}
              {startingBalance
                ? t('onb.account', { amount: money(startingBalance, ccy, { decimals: 0 }) })
                : null}
            </p>
          ) : null}
          {screen ? (
            <>
              <p className="m-0 text-5xl text-accent" aria-hidden="true">
                {screen.art}
              </p>
              <h1 ref={heading} tabIndex={-1} className="font-display text-3xl m-0 outline-none">
                {t(screen.title)}
              </h1>
              <p className="m-0 text-lg leading-relaxed">
                <Rich text={t(screen.body)} />
              </p>
              <div className="flex gap-3 justify-between">
                {step > 0 ? (
                  <Button onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
                ) : (
                  <span />
                )}
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => setStep(step + 1)}
                  data-testid="onboarding-next"
                >
                  {t('common.next')}
                </Button>
              </div>
            </>
          ) : step === SCREENS.length ? (
            <div data-testid="disclosure-step">
              <h1 ref={heading} tabIndex={-1} className="font-display text-3xl m-0 outline-none">
                {doc?.title ?? t('onb.d.title')}
              </h1>
              {stale ? (
                <p className="k-error" role="alert">
                  {t('onb.d.stale')}
                </p>
              ) : null}
              <ul
                className="mt-3 mb-0 pl-5 flex flex-col gap-2 text-[17px] leading-relaxed"
                data-testid="disclosure-body"
              >
                {(doc?.body ?? []).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              {doc?.placeholder ? (
                <p className="text-sm text-muted mb-0">{t('shell.banner.placeholder')}</p>
              ) : null}
              <p className="text-xs text-muted">
                {doc ? t('onb.d.version', { version: doc.version }) : null}
              </p>
              {acked ? (
                <div className="flex gap-3 justify-between">
                  <Button onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={() => setStep(step + 1)}
                    data-testid="onboarding-next"
                  >
                    {t('common.next')}
                  </Button>
                </div>
              ) : (
                <>
                  <label className="flex items-start gap-3 min-h-11 cursor-pointer mt-2">
                    <input
                      type="checkbox"
                      className="w-6 h-6 mt-0.5 accent-[var(--k-accent)] shrink-0"
                      checked={ticked}
                      onChange={(e) => setTicked(e.target.checked)}
                      data-testid="disclosure-ack"
                    />
                    <span className="font-semibold">{doc?.acknowledge}</span>
                  </label>
                  <div className="flex gap-3 justify-between mt-3">
                    <Button onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
                    <Button
                      variant="primary"
                      size="lg"
                      disabled={!ticked || busy || !doc}
                      onClick={() => void acknowledge()}
                      data-testid="disclosure-confirm"
                    >
                      {t('onb.d.confirm')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div data-testid="limits-step" className="flex flex-col gap-4">
              <h1 ref={heading} tabIndex={-1} className="font-display text-3xl m-0 outline-none">
                {t('onb.l.title')}
              </h1>
              <p className="m-0 leading-relaxed">
                <Rich
                  text={t('onb.l.body', {
                    dailyPct: profile.suggestedLimits.dailyPct,
                    monthlyPct: profile.suggestedLimits.monthlyPct,
                  })}
                />
              </p>
              <ExplainThis
                topic="loss_limits"
                locale={locale}
                context={{ daily, monthly, currency: ccy }}
              />
              <NumberInput
                label={t('limits.daily')}
                hint={t('onb.l.suggested', {
                  amount: money(profile.suggestedLimits.daily, ccy, { decimals: 0 }),
                })}
                value={daily}
                onValueChange={setDaily}
                precision={2}
                min="0"
                data-testid="onboarding-daily"
              />
              <NumberInput
                label={t('limits.monthly')}
                hint={t('onb.l.suggested', {
                  amount: money(profile.suggestedLimits.monthly, ccy, { decimals: 0 }),
                })}
                value={monthly}
                onValueChange={setMonthly}
                precision={2}
                min="0"
                data-testid="onboarding-monthly"
              />
              {error ? (
                <p className="k-error m-0" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="flex gap-3 justify-between">
                <Button onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
                <Button
                  variant="primary"
                  size="lg"
                  disabled={busy}
                  onClick={() => void finish()}
                  data-testid="onboarding-finish"
                >
                  {t('onb.l.finish')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
