'use client';

import { Banner, Button, NumberInput, Panel } from '@kora/ui';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { SimApiError, simApi } from '@/lib/sim/client';
import { fmtMoney } from '@/lib/sim/format';
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

/** Inline link to the glossary entry at the bottom of the page. */
function Term({ id, children }: { id: string; children: ReactNode }) {
  return (
    <a
      href={`#glossary-${id}`}
      className="text-accent underline decoration-dotted underline-offset-2"
      data-glossary={id}
    >
      {children}
    </a>
  );
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
  options: Record<V, { label: string; hint: string }>;
  onChange: (v: V) => void;
}) {
  return (
    <fieldset className="border-0 m-0 p-0">
      <legend className="font-semibold mb-2">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(options) as V[]).map((k) => (
          <label
            key={k}
            className={`flex flex-col gap-0.5 p-3 rounded-xl border cursor-pointer ${value === k ? 'border-accent bg-up-surface' : 'border-border bg-panel'}`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                value={k}
                checked={value === k}
                onChange={() => onChange(k)}
                className="accent-[var(--k-accent)]"
              />
              <span className="font-semibold">{options[k].label}</span>
            </span>
            <span className="text-sm text-muted pl-6">{options[k].hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const QUICK_AMOUNTS = ['1000', '5000', '10000'];

/** Novice Practice: three plain questions, three numbers, one band chart, and no promises. */
export function Practice() {
  const [amount, setAmount] = useState('10000');
  const [often, setOften] = useState<HowOften>('weekly');
  const [careful, setCareful] = useState<HowCareful>('balanced');
  const [result, setResult] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const n = Number(amount);
      setResult(
        await simApi.project(
          practiceRequest({ amount: Number.isFinite(n) ? n : MIN_AMOUNT, often, careful }),
        ),
      );
    } catch (e) {
      setError(
        e instanceof SimApiError && e.status < 500
          ? e.message
          : 'We could not run the practice year just now. Please try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  const outcomes = result ? yearOutcomes(result) : [];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Panel title="Practice: what could a year of trading look like?" data-testid="practice-form">
        <p className="mt-0 mb-5 text-muted">
          Answer three questions. We&apos;ll play out a year of practice trading thousands of times
          and show you the range.
        </p>
        <div className="flex flex-col gap-5">
          <div>
            <NumberInput
              label="1 · How much practice money? (in dollars)"
              value={amount}
              onValueChange={setAmount}
              precision={0}
              min={String(MIN_AMOUNT)}
              max={String(MAX_AMOUNT)}
              data-testid="practice-amount"
            />
            <div className="flex flex-wrap gap-2 mt-2" role="group" aria-label="Quick amounts">
              {QUICK_AMOUNTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="k-btn k-btn--sm"
                  aria-pressed={amount === q}
                  onClick={() => setAmount(q)}
                >
                  {fmtMoney(Number(q))}
                </button>
              ))}
            </div>
          </div>
          <Choice
            legend="2 · How often would you trade?"
            name="often"
            value={often}
            options={HOW_OFTEN}
            onChange={setOften}
          />
          <Choice
            legend="3 · How careful would you be?"
            name="careful"
            value={careful}
            options={HOW_CAREFUL}
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
            {busy ? 'Working it out…' : result ? 'Show me again' : 'Show me a practice year'}
          </Button>
          {error ? (
            <Banner tone="critical" title="Nothing was worked out.">
              {error}
            </Banner>
          ) : null}
        </div>
      </Panel>

      <div className="flex flex-col gap-5">
        <Panel title="Your practice year" data-testid="practice-result">
          <p className="mt-0 text-lg font-semibold" data-testid="not-a-promise">
            This is a <Term id="simulation">simulation</Term>, not a promise.
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
                      <p className="m-0 text-sm text-muted">{o.title}</p>
                      <p className="m-0 font-display text-3xl">{fmtMoney(o.end)}</p>
                      <p className={`m-0 text-sm font-semibold ${up ? 'text-up' : 'text-down'}`}>
                        {up ? '▲ up' : '▼ down'} {fmtMoney(Math.abs(o.change))}
                      </p>
                      <p className="m-0 mt-1 text-sm text-muted">{o.explain}</p>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-4">
                <p className="m-0 mb-2 text-sm">
                  The shaded area is the <Term id="range">likely range</Term>. The dark line is the
                  typical path, and the dashed line is where you started.
                </p>
                <FanChart
                  result={result}
                  simple
                  title="Likely range of your practice money over 12 months"
                  periodLabel={(k) => (k === 0 ? 'Now' : `Month ${k}`)}
                  height={300}
                />
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer font-semibold">How we worked this out</summary>
                <p className="mb-0">
                  We assume no special skill: half of the trades win, a win is the same size as a
                  loss, every trade has <Term id="costs">costs</Term>, and now and then a price
                  jumps past your <Term id="safety-net">safety net</Term>. Past results are not a
                  promise of future results.
                </p>
              </details>
            </>
          ) : (
            <p className="text-muted mb-0" data-testid="practice-empty">
              Pick your answers and press &ldquo;Show me a practice year&rdquo;. Nothing here uses
              real money.
            </p>
          )}
        </Panel>

        <Panel title="Words used here" data-testid="glossary">
          <dl className="m-0 flex flex-col gap-3" data-glossary-list="">
            {PRACTICE_GLOSSARY.map((g) => (
              <div key={g.id} id={`glossary-${g.id}`} tabIndex={-1}>
                <dt className="font-semibold">{g.term}</dt>
                <dd className="m-0 text-muted">{g.meaning}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </div>
  );
}
