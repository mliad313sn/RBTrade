'use client';

import { KoraApiError, type AutoInvestList, type AutoInvestTemplate } from '@kora/sdk';
import { Button, Dialog, NumberInput, useToast } from '@kora/ui';
import { useState } from 'react';

import { api } from '@/lib/api-browser';
import { hasKey, type MessageKey } from '@/lib/i18n';
import { Rich, useI18n } from '@/lib/i18n/react';
import { ExplainThis } from '@/lib/novice/explain-slot';

import { RiskBars, useTemplateText } from './common';

function key(k: string): MessageKey | null {
  return hasKey(k) ? k : null;
}

function Card({
  tpl,
  ccy,
  bounds,
  onList,
}: {
  tpl: AutoInvestTemplate;
  ccy: string;
  bounds: { min: string; max: string };
  onList: (l: AutoInvestList) => void;
}) {
  const { t, money, pct, locale } = useI18n();
  const text = useTemplateText();
  const toast = useToast();
  const [start, setStart] = useState(false);
  const [live, setLive] = useState(false);
  const [amount, setAmount] = useState(bounds.min);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const robot = tpl.robot;

  const errText = (e: unknown) => {
    if (e instanceof KoraApiError) {
      const k = key(`ai.err.${e.code}`);
      if (k) return t(k, { min: money(bounds.min, ccy), max: money(bounds.max, ccy) });
    }
    return t('common.error');
  };
  const run = async (fn: () => Promise<AutoInvestList>, ok?: string) => {
    setBusy(true);
    setError(null);
    try {
      onList(await fn());
      if (ok) toast.push(ok, 'success', 6000);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="k-panel" data-testid={`template-${tpl.id}`}>
      <div className="k-panel__body flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-xl">{text(tpl.id, 'name')}</h2>
            <p className="m-0 text-muted">{text(tpl.id, 'summary')}</p>
          </div>
          <span className="flex flex-col items-end gap-1 shrink-0">
            <RiskBars level={tpl.riskLevel} label={t('ai.risk', { n: tpl.riskLevel })} />
            <span className="text-xs text-muted">{t('ai.risk', { n: tpl.riskLevel })}</span>
          </span>
        </div>
        <details>
          <summary className="cursor-pointer font-semibold min-h-11 inline-flex items-center">
            <span className="k-disclosure__icon" aria-hidden="true">
              ▸
            </span>
            {t('ai.riskWhy')}
          </summary>
          <ul className="m-0 pl-5 text-sm">
            {tpl.factors.map((f) => (
              <li key={f}>{t(`ai.factor.${f}`)}</li>
            ))}
          </ul>
          <ExplainThis
            topic="robot_risk_level"
            locale={locale}
            context={{
              templateId: tpl.id,
              riskLevel: String(tpl.riskLevel),
              factors: tpl.factors.join(','),
            }}
          />
        </details>
        <div
          className="p-3 rounded-lg bg-raised border border-border text-sm"
          data-testid={`oos-${tpl.id}`}
        >
          <p className="m-0 font-semibold">
            <Rich text={t('ai.results.title')} />
          </p>
          <p className="m-0 mt-1">
            {tpl.oos && tpl.oos.returnPct !== null
              ? t('ai.results.line', {
                  ret: pct(tpl.oos.returnPct, { signed: true, decimals: 1 }),
                  dip: pct(tpl.oos.worstDipPct ?? '0', { decimals: 1 }),
                  n: tpl.oos.trades,
                  days: tpl.oos.days ?? 0,
                })
              : t('ai.results.none')}
          </p>
          <p className="m-0 mt-1 text-muted">
            {t('ai.promise')} {t('common.simulated')}
          </p>
        </div>
        {robot && robot.status !== 'stopped' ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2"
            data-testid={`robot-${tpl.id}`}
          >
            <span>
              <span className="block font-semibold">
                {t(robot.status === 'running' ? 'ai.mine.running' : 'ai.mine.paused')}
              </span>
              <span className="block text-sm text-muted">
                {t('ai.mine.line', {
                  amount: money(robot.allocation, ccy),
                  pnl: money(robot.pnl, ccy, { signed: true }),
                })}
              </span>
            </span>
            <span className="flex gap-2">
              {robot.status === 'running' ? (
                <Button
                  disabled={busy}
                  onClick={() => void run(() => api.pauseAutoInvest(robot.id))}
                  data-testid={`pause-${tpl.id}`}
                >
                  {t('ai.pause')}
                </Button>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() => void run(() => api.resumeAutoInvest(robot.id))}
                  data-testid={`resume-${tpl.id}`}
                >
                  {t('ai.resume')}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setLive(true)} data-testid={`live-${tpl.id}`}>
                {t('ai.live')}
              </Button>
            </span>
          </div>
        ) : (
          <Button variant="primary" onClick={() => setStart(true)} data-testid={`start-${tpl.id}`}>
            {t('ai.start')}
          </Button>
        )}
        {error && !start ? (
          <p className="k-error m-0" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Dialog
        open={start}
        onOpenChange={setStart}
        title={text(tpl.id, 'name')}
        description={t('ai.promise')}
        data-testid="start-robot-dialog"
      >
        <div className="flex flex-col gap-3">
          <NumberInput
            label={t('ai.amount')}
            hint={t('ai.amountHint', { min: money(bounds.min, ccy), max: money(bounds.max, ccy) })}
            value={amount}
            onValueChange={setAmount}
            precision={2}
            min="0"
            data-testid="robot-amount"
          />
          <p className="m-0 text-sm text-muted">{t('review.practice')}</p>
          {error ? (
            <p className="k-error m-0" role="alert">
              {error}
            </p>
          ) : null}
          <div className="k-dialog__actions">
            <Button onClick={() => setStart(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                if (await run(() => api.startAutoInvest(tpl.id, amount), t('ai.started')))
                  setStart(false);
              }}
              data-testid="confirm-robot"
            >
              {t('ai.confirm')}
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={live}
        onOpenChange={setLive}
        title={t('ai.liveTitle')}
        description={t('ai.liveBody')}
        data-testid="live-dialog"
      >
        <ul className="m-0 pl-5">
          <li>{t('ai.live.knowledge_check')}</li>
          <li>{t('ai.live.promotion_rules')}</li>
          <li>{t('ai.live.live_trading_enabled')}</li>
        </ul>
        <div className="k-dialog__actions">
          <Button onClick={() => setLive(false)}>{t('common.close')}</Button>
        </div>
      </Dialog>
    </li>
  );
}

/** Auto-invest (goal 08 §6, B-614): ready-made robots only, practice money, OOS results only. */
export function AutoInvest({ initial }: { initial: AutoInvestList | null }) {
  const { t } = useI18n();
  const [list, setList] = useState(initial);
  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <h1 className="font-display text-3xl m-0">{t('ai.title')}</h1>
      <p className="m-0 text-lg">
        <Rich text={t('ai.intro')} />
      </p>
      <p className="m-0 font-semibold" data-testid="past-results-note">
        {t('ai.promise')}
      </p>
      {list ? (
        <ul className="list-none m-0 p-0 flex flex-col gap-4">
          {list.templates.map((tpl) => (
            <Card
              key={tpl.id}
              tpl={tpl}
              ccy={list.currency}
              bounds={list.amount}
              onList={setList}
            />
          ))}
        </ul>
      ) : (
        <p>{t('common.error')}</p>
      )}
    </div>
  );
}
