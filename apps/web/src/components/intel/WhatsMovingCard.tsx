'use client';

import { useEffect, useState } from 'react';

import { useI18n } from '@/lib/i18n/react';
import { intelApi, type MovingItem } from '@/lib/intel/client';

/**
 * Novice "What's moving and why" card (goal 07B §6), placed on the novice Home by goal 08. Plain
 * words (grade ≤ 8), no trade suggestion, a figure only when it is calibrated, and the news source
 * for the "why". Data: `GET /intel/whats-moving` (SIMULATED). Worded in the viewer's language
 * through the goal 08 i18n (`moving.*` keys) from the item's structured fields; `names` maps a
 * symbol to its localised novice name when the caller has one.
 */
export function WhatsMovingCard({
  limit = 3,
  names,
}: {
  limit?: number;
  names?: Readonly<Record<string, string>>;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<MovingItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    intelApi
      .whatsMoving()
      .then((r) => setItems(r.items.slice(0, limit)))
      .catch(() => setFailed(true));
  }, [limit]);

  const headline = (it: MovingItem) =>
    it.move ? t(`moving.${it.move}`, { name: names?.[it.symbol] ?? it.name }) : it.headline;
  const why = (it: MovingItem) =>
    it.news ? t('moving.news', { title: it.news.title, source: it.news.source }) : it.why;
  const odds = (it: MovingItem) =>
    it.odds ? t('moving.odds', { per100: it.odds.per100, n: it.odds.n }) : it.confidence;

  return (
    <section
      className="rounded border border-border bg-panel p-3"
      aria-labelledby="whats-moving-h"
      data-testid="whats-moving"
    >
      <h2 id="whats-moving-h" className="m-0 mb-2 text-base font-semibold">
        {t('moving.title')}
      </h2>
      {failed && <p className="m-0 text-sm text-muted">{t('moving.failed')}</p>}
      {!failed && items === null && <p className="m-0 text-sm text-muted">{t('moving.loading')}</p>}
      {items && !items.length && <p className="m-0 text-sm text-muted">{t('moving.empty')}</p>}
      {items && items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((it) => (
            <li key={it.symbol} data-testid="whats-moving-item">
              <p className="m-0 text-sm font-semibold">{headline(it)}</p>
              {why(it) && (
                <p className="m-0 text-sm">
                  {why(it)}{' '}
                  {it.whySource && (
                    <a
                      href={it.whySource.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="underline inline-flex items-center min-h-11"
                      data-article-id={it.whySource.id}
                    >
                      {t('moving.source')}
                    </a>
                  )}
                </p>
              )}
              {odds(it) && <p className="m-0 text-sm text-muted">{odds(it)}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 mt-2 text-xs text-muted">
        {t('moving.note')} {t('moving.disclaimer')}
      </p>
    </section>
  );
}
