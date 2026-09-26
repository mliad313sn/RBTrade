'use client';

import type { AutoInvestList, NoviceProfile } from '@kora/sdk';
import Link from 'next/link';

import { Rich, useI18n } from '@/lib/i18n/react';
import { ExplainThis } from '@/lib/novice/explain-slot';

import { RiskBars, useTemplateText } from './common';

/** Calm cooling-off card (goal 08 §4): what happened, when it ends, closing still allowed. */
export function CoolingOffCard({ profile }: { profile: NoviceProfile | null }) {
  const { t, dateTime, pct, locale } = useI18n();
  const c = profile?.coolingOff;
  if (!c?.active || !c.reason) return null;
  const why =
    c.reason === 'losing_trades'
      ? t('cool.losing_trades', { n: c.losingTradesToday })
      : c.reason === 'daily_loss_pct'
        ? t('cool.daily_loss_pct', { pct: pct(c.dayLossPct, { decimals: 1 }) })
        : t('cool.daily_loss_limit');
  return (
    <section
      className="k-panel border-warn! bg-warn-surface!"
      aria-labelledby="cool-title"
      data-testid="cooling-off"
      role="status"
    >
      <div className="k-panel__body">
        <h2 id="cool-title" className="font-display text-2xl m-0">
          {t('cool.title')}
        </h2>
        <p className="m-0 mt-2 font-semibold">{why}</p>
        <p className="m-0 mt-2">{t('cool.body', { time: c.until ? dateTime(c.until) : '' })}</p>
        <div className="flex flex-wrap items-center gap-3 mt-2">
          <Link
            href="/learn/losses"
            className="text-accent font-semibold inline-flex items-center min-h-11"
          >
            {t('cool.learn')}
          </Link>
          <ExplainThis
            topic="cooling_off"
            locale={locale}
            context={{
              reason: c.reason,
              losingTradesToday: String(c.losingTradesToday),
              dayLossPct: c.dayLossPct,
            }}
          />
        </div>
      </div>
    </section>
  );
}

/** Home card: the ready-made robots with their risk level; details live on /auto-invest. */
export function AutoInvestCard({ list }: { list: AutoInvestList | null }) {
  const { t } = useI18n();
  const text = useTemplateText();
  return (
    <section className="k-panel" aria-labelledby="ai-card-title" data-testid="auto-invest-card">
      <div className="k-panel__body">
        <h2 id="ai-card-title" className="k-panel__title m-0">
          {t('ai.title')}
        </h2>
        <p className="m-0 text-sm text-muted">{t('ai.card.subtitle')}</p>
        <ul className="list-none m-0 p-0 mt-2">
          {(list?.templates ?? []).map((tpl) => (
            <li
              key={tpl.id}
              className="flex items-center justify-between gap-3 py-2 border-t border-border"
            >
              <span>
                <span className="block font-semibold">{text(tpl.id, 'name')}</span>
                <span className="block text-xs text-muted">{text(tpl.id, 'summary')}</span>
              </span>
              <RiskBars level={tpl.riskLevel} label={t('ai.risk', { n: tpl.riskLevel })} />
            </li>
          ))}
        </ul>
        <p className="m-0 mt-2 text-xs text-muted">{t('ai.promise')}</p>
        <Link
          href="/auto-invest"
          className="text-accent font-semibold inline-flex items-center min-h-11"
        >
          {t('ai.card.more')}
        </Link>
      </div>
    </section>
  );
}

export function LearnCard() {
  const { t } = useI18n();
  return (
    <section className="k-panel" aria-labelledby="learn-card-title" data-testid="learn-card">
      <div className="k-panel__body">
        <h2 id="learn-card-title" className="k-panel__title m-0">
          {t('learn.card.title')}
        </h2>
        <p className="mt-2 mb-0 leading-relaxed">
          <Rich text={t('learn.card.spread')} />
        </p>
        <p className="mt-2 mb-0 leading-relaxed">
          <Rich text={t('learn.card.stop')} />
        </p>
        <Link href="/learn" className="text-accent font-semibold inline-flex items-center min-h-11">
          {t('learn.card.more')}
        </Link>
      </div>
    </section>
  );
}
