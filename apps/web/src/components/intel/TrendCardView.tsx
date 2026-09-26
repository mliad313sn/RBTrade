'use client';

import Link from 'next/link';
import { useState } from 'react';

import { intelApi, signed, trendArrow, type TrendCard } from '@/lib/intel/client';

import { DriversChart } from './DriversChart';

export interface TrendCardViewProps {
  card: TrendCard;
  canDraft: boolean;
  canBuild: boolean;
  onDraft?: (draftId: string, symbol: string) => void;
}

function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}

/**
 * One trend card (goal 07B §5): direction and horizon, calibrated probability or "No reliable signal",
 * drivers, cited news with sources, what would invalidate the view, risk and volatility context,
 * a copilot summary grounded in this card, and the draft / robot-builder hand-offs.
 */
export function TrendCardView({ card, canDraft, canBuild, onDraft }: TrendCardViewProps) {
  const [summary, setSummary] = useState<string>('');
  const [explaining, setExplaining] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  const explain = async () => {
    setExplaining(true);
    setSummary('');
    setNotice(null);
    try {
      let acc = '';
      const a = await intelApi.explain(card.symbol, card.horizon, (t) => {
        acc += t;
        setSummary(acc);
      });
      if (a.status === 'ok') setSummary(a.answer);
      else setNotice(a.message);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setExplaining(false);
    }
  };

  const draft = async () => {
    setDrafting(true);
    setNotice(null);
    try {
      const d = await intelApi.draft(card.symbol, card.horizon);
      onDraft?.(d.draftId, card.symbol);
    } catch (e) {
      setNotice((e as Error).message);
      setDrafting(false);
    }
  };

  const p = card.probability;
  const template = card.direction === 'down' ? 'trend-x' : card.trend?.kind.startsWith('breakout') ? 'breakout-crypto' : 'trend-x';
  return (
    <article className="flex flex-col gap-3 text-sm" data-testid="trend-card" aria-labelledby="trend-card-title">
      <header>
        <h2 id="trend-card-title" className="m-0 text-base font-semibold">
          {card.name} <span className="text-muted">({card.symbol})</span>
        </h2>
        <p className="m-0 text-xs text-muted">
          {card.regionLabel} · {card.assetClass} · {card.sector.replace(/_/g, ' ')} · {card.venue} · {card.currency} · SIMULATED data
        </p>
      </header>

      <section aria-label="View" className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span data-testid="trend-direction">
          {card.trend ? `${trendArrow(card.trend.kind)} ${card.trend.label}` : 'No trend label'}
          {card.direction ? ` · direction ${card.direction === 'up' ? '▲ up' : '▼ down'}` : ''} · horizon {card.horizon}
        </span>
        {p.status === 'calibrated' ? (
          <span data-testid="trend-probability" className="font-semibold">
            Probability {p.value} <span className="text-muted">(calibrated, n={p.n})</span>
          </span>
        ) : (
          <span data-testid="trend-no-signal" className="font-semibold text-warn">
            No reliable signal
          </span>
        )}
      </section>
      <p className="m-0 text-xs text-muted" data-testid="trend-reliability">
        {p.status === 'calibrated' ? p.reliabilityLine : p.reason}
      </p>

      <section aria-labelledby="drivers-h">
        <h3 id="drivers-h" className="m-0 mb-1 text-xs font-semibold uppercase text-muted">
          Top drivers
        </h3>
        <DriversChart card={card} />
      </section>

      <section aria-labelledby="news-h">
        <h3 id="news-h" className="m-0 mb-1 text-xs font-semibold uppercase text-muted">
          Linked news
        </h3>
        {card.news.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs" data-testid="trend-news">
            {card.news.map((n) => (
              <li key={n.id} data-testid="trend-news-item" data-article-id={n.id}>
                <a href={n.url} rel="noopener noreferrer nofollow" target="_blank" className="underline">
                  {n.translatedTitle ?? n.title}
                </a>{' '}
                <span className="text-muted">
                  — {n.source}, {n.publishedAt.slice(0, 16).replace('T', ' ')} UTC{n.language && n.language !== 'en' ? ` · translated from ${n.language}` : ''}
                  {n.sentiment !== null ? ` · sentiment ${n.sentiment > 0 ? '▲' : n.sentiment < 0 ? '▼' : '•'} ${signed(n.sentiment)}` : ' · not scored'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-xs text-muted">No linked news in the past week.</p>
        )}
      </section>

      <section aria-labelledby="inval-h">
        <h3 id="inval-h" className="m-0 mb-1 text-xs font-semibold uppercase text-muted">
          What would invalidate this view
        </h3>
        <p className="m-0 text-xs" data-testid="trend-invalidation">
          {card.invalidation?.rule ?? 'There is no directional view, so there is no invalidation level.'}
        </p>
      </section>

      <section aria-labelledby="risk-h">
        <h3 id="risk-h" className="m-0 mb-1 text-xs font-semibold uppercase text-muted">
          Risk and volatility
        </h3>
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs" data-testid="trend-risk">
          <dt className="text-muted">Last close</dt>
          <dd className="k-num m-0">{card.risk.lastClose ?? '—'}</dd>
          <dt className="text-muted">ATR (14)</dt>
          <dd className="k-num m-0">
            {card.risk.atr ?? '—'} {card.risk.atrPct !== null ? `(${card.risk.atrPct}% of price)` : ''}
          </dd>
          <dt className="text-muted">Regime</dt>
          <dd className="m-0">
            trending {pct(card.regime.trending)} · ranging {pct(card.regime.ranging)} · volatile {pct(card.regime.volatile)}
          </dd>
          <dt className="text-muted">Next high-impact event</dt>
          <dd className="m-0">{card.risk.eventMinutes === null ? 'none scheduled' : `in ${card.risk.eventMinutes} min`}</dd>
        </dl>
      </section>

      <section aria-labelledby="summary-h" className="rounded border border-border p-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="summary-h" className="m-0 text-xs font-semibold uppercase text-ai">
            ✦ Copilot summary
          </h3>
          <button type="button" className="ai-strip__btn" onClick={() => void explain()} disabled={explaining} data-testid="trend-explain">
            {explaining ? 'Writing…' : 'Explain'}
          </button>
        </div>
        {summary ? (
          <p className="m-0 mt-1 whitespace-pre-line text-xs" data-testid="trend-summary" aria-live="polite">
            {summary}
          </p>
        ) : (
          <p className="m-0 mt-1 text-xs text-muted">Written from this card only; every number is checked against it.</p>
        )}
      </section>

      {notice && (
        <p className="m-0 text-xs text-warn" role="status">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canDraft && card.direction && (
          <button type="button" className="ai-strip__btn" onClick={() => void draft()} disabled={drafting} data-testid="trend-draft">
            {drafting ? 'Drafting…' : 'Draft to ticket'}
          </button>
        )}
        {canBuild && (
          <Link
            href={`/robots/builder?template=${template}&symbol=${encodeURIComponent(card.symbol)}`}
            className="ai-strip__btn no-underline"
            data-testid="trend-send-builder"
          >
            Send to Robot builder
          </Link>
        )}
      </div>
      <p className="m-0 text-xs text-muted">
        Drafts open in the ticket for you to review; nothing is sent until you preview and confirm. {card.disclaimer}
      </p>
    </article>
  );
}
