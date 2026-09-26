'use client';

import { Panel } from '@kora/ui';
import type { NoviceSummary } from '@kora/sdk';

import { plain } from '@/lib/i18n';
import { Rich, useI18n } from '@/lib/i18n/react';
import { sinceText } from '@/lib/novice/view';

/** Simple SVG area chart of the balance (no chart library: small bundle for mobile). */
export function AreaChart({
  series,
  label,
}: {
  series: Array<{ t: string; equity: string }>;
  label: string;
}) {
  const w = 460;
  const h = 110;
  const ys = series.map((p) => Number(p.equity)); // display only: the numbers shown come from strings
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || Math.max(1, Math.abs(max) * 0.01);
  const flat = max === min;
  const pts = ys.map(
    (y, i) =>
      [
        series.length === 1 ? w : (i / (series.length - 1)) * w,
        flat ? h / 2 : h - 8 - ((y - min) / span) * (h - 24),
      ] as const,
  );
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-[110px]"
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
      data-testid="balance-chart"
    >
      <path d={area} fill="var(--k-up-surface)" />
      <path
        d={line}
        fill="none"
        stroke="var(--k-accent)"
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function BalanceCard({ summary }: { summary: NoviceSummary | null }) {
  const { t, money, pct } = useI18n();
  if (!summary) {
    return (
      <Panel title={t('home.balance.title')}>
        <p className="font-display text-5xl m-0" aria-label={t('common.loading')}>
          —
        </p>
      </Panel>
    );
  }
  const ccy = summary.currency;
  const change = summary.changeSinceStart;
  const up = !change.amount.startsWith('-');
  const flat = Number(change.amount) === 0;
  const dip = summary.worstDip;
  return (
    <section className="k-panel" aria-labelledby="balance-title" data-testid="balance-card">
      <div className="k-panel__body">
        <h2 id="balance-title" className="m-0 text-[15px] font-normal text-muted">
          {t('home.balance.title')}
        </h2>
        <p
          className="font-display text-[44px] md:text-5xl leading-tight m-0 mt-1"
          data-testid="practice-balance"
        >
          {money(summary.balance, ccy)}
        </p>
        <p
          className={`m-0 font-semibold ${flat ? 'text-muted' : up ? 'text-up' : 'text-down'}`}
          data-testid="balance-change"
        >
          <span aria-hidden="true">{flat ? '' : up ? '▲ ' : '▼ '}</span>
          {t('home.balance.change', {
            amount: money(change.amount, ccy, { signed: true }),
            pct: pct(change.pct, { signed: true, decimals: 1 }),
            since: sinceText(summary.startedAt, Date.now(), t),
          })}
        </p>
        <div className="mt-4">
          <AreaChart series={summary.series} label={t('home.chart.label')} />
        </div>
        <p className="m-0 mt-2 text-sm text-muted" data-testid="worst-dip">
          {Number(dip.amount) > 0 ? (
            <Rich
              text={t('home.dip', {
                amount: money(`-${dip.amount}`, ccy),
                pct: pct(`-${dip.pct}`, { decimals: 1 }),
              })}
            />
          ) : (
            plain(t('home.dip.none'))
          )}
        </p>
      </div>
    </section>
  );
}
