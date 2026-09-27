'use client';

import type { SavedScenario } from '@kora/sdk';
import { Banner, Button, Input, NumberInput, Panel, useToast } from '@kora/ui';
import { useEffect, useState } from 'react';

import type { MessageKey } from '@/lib/i18n';
import { Rich, useI18n } from '@/lib/i18n/react';
import { ExplainThis } from '@/lib/novice/explain-slot';
import { SimApiError, simApi } from '@/lib/sim/client';
import { PRACTICE_GLOSSARY } from '@/lib/sim/glossary';
import {
  HOW_CAREFUL,
  HOW_OFTEN,
  MAX_AMOUNT,
  MIN_AMOUNT,
  practiceRequest,
  yearOutcomes,
  type HowCareful,
  type HowOften,
} from '@/lib/sim/practice';
import type { SimResult } from '@/lib/sim/types';

import { FanChart } from './FanChart';

/** Glossary links stay on this page (the word list is at the bottom). */
const inPage = (id: string) => `#glossary-${id}`;

/** Simulation estimates are floats (ADR 0005): whole-currency display in the viewer's language. */
function simMoney(n: number, locale: 'en' | 'fr'): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function Choice<V extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: V;
  options: Array<{ value: V; label: string; hint: string }>;
  onChange: (v: V) => void;
}) {
  return (
    <fieldset className="border-0 m-0 p-0">
      <legend className="font-semibold mb-2">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex flex-col gap-0.5 p-3 rounded-xl border cursor-pointer min-h-11 ${value === o.value ? 'border-accent bg-accent-surface' : 'border-border bg-panel'}`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
                className="accent-[var(--k-accent)] w-5 h-5"
              />
              <span className="font-semibold">{o.label}</span>
            </span>
            <span className="text-sm text-muted pl-7">{o.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const QUICK_AMOUNTS = ['1000', '5000', '10000'];

interface PracticeInputs {
  amount: string;
  often: HowOften;
  careful: HowCareful;
}

/** Novice Practice: three plain questions, three numbers, one band chart, and no promises. */
export function Practice({ disclosurePct }: { disclosurePct?: string | null }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [amount, setAmount] = useState('10000');
  const [often, setOften] = useState<HowOften>('weekly');
  const [careful, setCareful] = useState<HowCareful>('balanced');
  const [result, setResult] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedScenario[]>([]);
  const [planName, setPlanName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    simApi
      .scenarios('practice')
      .then((r) => setSaved(r.scenarios))
      .catch(() => undefined);
  }, []);

  async function run(inputs: PracticeInputs = { amount, often, careful }) {
    setBusy(true);
    setError(null);
    try {
      const n = Number(inputs.amount);
      setResult(
        await simApi.project(
          practiceRequest({
            amount: Number.isFinite(n) ? n : MIN_AMOUNT,
            often: inputs.often,
            careful: inputs.careful,
          }),
        ),
      );
    } catch (e) {
      setError(e instanceof SimApiError && e.status < 500 ? e.message : t('practice.error'));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setSaveError(null);
    try {
      const s = await simApi.saveScenario({
        kind: 'practice',
        name: planName.trim(),
        input: { amount, often, careful },
      });
      setSaved((list) => [s, ...list.filter((x) => x.id !== s.id)]);
      setPlanName('');
      toast.push(t('practice.saved'), 'success', 4000);
    } catch (e) {
      setSaveError(
        e instanceof SimApiError && e.code === 'name_taken'
          ? t('practice.nameTaken')
          : t('common.error'),
      );
    }
  }

  function load(s: SavedScenario) {
    const i = s.input as Partial<PracticeInputs>;
    const next: PracticeInputs = {
      amount: typeof i.amount === 'string' ? i.amount : amount,
      often: i.often && i.often in HOW_OFTEN ? i.often : often,
      careful: i.careful && i.careful in HOW_CAREFUL ? i.careful : careful,
    };
    setAmount(next.amount);
    setOften(next.often);
    setCareful(next.careful);
    void run(next);
  }

  async function remove(s: SavedScenario) {
    await simApi.deleteScenario(s.id).catch(() => undefined);
    setSaved((list) => list.filter((x) => x.id !== s.id));
  }

  const outcomes = result ? yearOutcomes(result) : [];
  const oftenOptions = (Object.keys(HOW_OFTEN) as HowOften[]).map((k) => ({
    value: k,
    label: t(`practice.often.${k}` as MessageKey),
    hint: t(`practice.often.${k}.hint` as MessageKey),
  }));
  const carefulOptions = (Object.keys(HOW_CAREFUL) as HowCareful[]).map((k) => ({
    value: k,
    label: t(`practice.careful.${k}` as MessageKey),
    hint: t(`practice.careful.${k}.hint` as MessageKey),
  }));
  const chartTitle = t('practice.chartTitle');
  const last = result ? result.bands.p50.length - 1 : 0;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="flex flex-col gap-5">
        <Panel title={t('practice.formTitle')} data-testid="practice-form">
          <p className="mt-0 mb-5 text-muted">{t('practice.formIntro')}</p>
          <div className="flex flex-col gap-5">
            <div>
              <NumberInput
                label={t('practice.amount')}
                value={amount}
                onValueChange={setAmount}
                precision={0}
                min={String(MIN_AMOUNT)}
                max={String(MAX_AMOUNT)}
                data-testid="practice-amount"
              />
              <div
                className="flex flex-wrap gap-2 mt-2"
                role="group"
                aria-label={t('practice.quick')}
              >
                {QUICK_AMOUNTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="k-btn k-btn--sm"
                    aria-pressed={amount === q}
                    onClick={() => setAmount(q)}
                  >
                    {simMoney(Number(q), locale)}
                  </button>
                ))}
              </div>
            </div>
            <Choice
              legend={t('practice.often')}
              name="often"
              value={often}
              options={oftenOptions}
              onChange={setOften}
            />
            <Choice
              legend={t('practice.careful')}
              name="careful"
              value={careful}
              options={carefulOptions}
              onChange={setCareful}
            />
            <Button
              variant="primary"
              size="lg"
              block
              onClick={() => void run()}
              disabled={busy}
              data-testid="practice-run"
            >
              {busy ? t('practice.working') : result ? t('practice.again') : t('practice.run')}
            </Button>
            {error ? (
              <Banner tone="critical" title={t('practice.errorTitle')}>
                {error}
              </Banner>
            ) : null}
          </div>
        </Panel>

        <Panel title={t('practice.savedTitle')} data-testid="saved-plans">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (planName.trim()) void save();
            }}
          >
            <div className="flex-1 min-w-48">
              <Input
                label={t('practice.saveName')}
                value={planName}
                maxLength={60}
                onChange={(e) => setPlanName(e.target.value)}
                data-testid="plan-name"
              />
            </div>
            <Button type="submit" disabled={!planName.trim()} data-testid="save-plan">
              {t('practice.save')}
            </Button>
          </form>
          {saveError ? (
            <p className="k-error mb-0" role="alert">
              {saveError}
            </p>
          ) : null}
          {saved.length ? (
            <ul className="list-none m-0 mt-3 p-0 flex flex-col gap-2">
              {saved.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2"
                  data-testid="saved-plan"
                >
                  <span className="font-semibold truncate">{s.name}</span>
                  <span className="flex gap-2">
                    <Button
                      onClick={() => load(s)}
                      aria-label={t('practice.loadAria', { name: s.name })}
                    >
                      {t('practice.load')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void remove(s)}
                      aria-label={t('practice.deleteAria', { name: s.name })}
                    >
                      {t('practice.delete')}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      </div>

      <div className="flex flex-col gap-5">
        <Panel title={t('practice.resultTitle')} data-testid="practice-result">
          <p className="mt-0 text-lg font-semibold" data-testid="not-a-promise">
            <Rich text={t('practice.notPromise')} termHref={inPage} />
          </p>
          {result ? (
            <>
              <ul className="list-none m-0 p-0 grid gap-3 sm:grid-cols-3">
                {outcomes.map((o) => {
                  const up = o.change >= 0;
                  return (
                    <li
                      key={o.key}
                      className="p-4 rounded-xl border border-border bg-raised"
                      data-testid={`year-${o.key}`}
                      data-value={o.end}
                    >
                      <p className="m-0 text-sm text-muted">
                        {t(`practice.${o.key}` as MessageKey)}
                      </p>
                      <p className="m-0 font-display text-3xl">{simMoney(o.end, locale)}</p>
                      <p className={`m-0 text-sm font-semibold ${up ? 'text-up' : 'text-down'}`}>
                        {up ? t('practice.up') : t('practice.down')}{' '}
                        {simMoney(Math.abs(o.change), locale)}
                      </p>
                      <p className="m-0 mt-1 text-sm text-muted">
                        {t(`practice.${o.key}.explain` as MessageKey)}
                      </p>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-4">
                <p className="m-0 mb-2 text-sm">
                  <Rich text={t('practice.range')} termHref={inPage} />
                </p>
                <FanChart
                  result={result}
                  simple
                  title={chartTitle}
                  periodLabel={(k) => (k === 0 ? t('practice.now') : t('practice.month', { n: k }))}
                  height={300}
                  watermark={t('practice.watermark')}
                  summaryText={t('practice.chartSummary', {
                    title: chartTitle,
                    months: last,
                    mid: simMoney(result.bands.p50[last]!, locale),
                    low: simMoney(result.bands.p5[last]!, locale),
                    high: simMoney(result.bands.p95[last]!, locale),
                    start: simMoney(result.startingCapital, locale),
                  })}
                />
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer font-semibold min-h-11 inline-flex items-center">
                  <span className="k-disclosure__icon" aria-hidden="true">
                    ▸
                  </span>
                  {t('practice.howTitle')}
                </summary>
                <p className="mb-0">
                  <Rich text={t('practice.how')} termHref={inPage} />
                </p>
              </details>
              {disclosurePct ? (
                <p className="mt-3 mb-0 text-sm text-muted" data-testid="practice-disclosure">
                  {t('practice.disclosure', { pct: disclosurePct })}
                </p>
              ) : null}
              <ExplainThis
                topic="practice_year"
                locale={locale}
                context={{
                  good: String(Math.round(result.finalEquity.p95)),
                  typical: String(Math.round(result.finalEquity.p50)),
                  bad: String(Math.round(result.finalEquity.p5)),
                }}
              />
            </>
          ) : (
            <p className="text-muted mb-0" data-testid="practice-empty">
              {t('practice.empty')}
            </p>
          )}
        </Panel>

        <Panel title={t('practice.words')} data-testid="glossary">
          <dl className="m-0 flex flex-col gap-3" data-glossary-list="">
            {PRACTICE_GLOSSARY.map((g) => (
              <div key={g.id} id={`glossary-${g.id}`} tabIndex={-1}>
                <dt className="font-semibold">{t(`term.${g.id}.name` as MessageKey)}</dt>
                <dd className="m-0 text-muted">{t(`term.${g.id}.meaning` as MessageKey)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </div>
  );
}
