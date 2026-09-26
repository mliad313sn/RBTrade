'use client';

import { useEffect, useState } from 'react';

import { intelApi, type MovingItem } from '@/lib/intel/client';

/**
 * Novice "What's moving and why" card (goal 07B §6), exported for the novice Home (goal 08 places
 * it). Plain words (grade ≤ 8), no trade suggestion, a figure only when it is calibrated, and the
 * news source for the "why". Data: `GET /intel/whats-moving` (SIMULATED).
 */
export function WhatsMovingCard({ limit = 3 }: { limit?: number }) {
  const [items, setItems] = useState<MovingItem[] | null>(null);
  const [note, setNote] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    intelApi
      .whatsMoving()
      .then((r) => {
        setItems(r.items.slice(0, limit));
        setNote(`${r.note} ${r.disclaimer}`);
      })
      .catch(() => setFailed(true));
  }, [limit]);

  return (
    <section className="rounded border border-border bg-panel p-3" aria-labelledby="whats-moving-h" data-testid="whats-moving">
      <h2 id="whats-moving-h" className="m-0 mb-2 text-base font-semibold">
        What&apos;s moving and why
      </h2>
      {failed && <p className="m-0 text-sm text-muted">This is not available right now.</p>}
      {!failed && items === null && <p className="m-0 text-sm text-muted">Loading…</p>}
      {items && !items.length && <p className="m-0 text-sm text-muted">Nothing stands out in the practice market right now.</p>}
      {items && items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((it) => (
            <li key={it.symbol} data-testid="whats-moving-item">
              <p className="m-0 text-sm font-semibold">{it.headline}</p>
              {it.why && (
                <p className="m-0 text-sm">
                  {it.why}{' '}
                  {it.whySource && (
                    <a href={it.whySource.url} target="_blank" rel="noopener noreferrer nofollow" className="underline" data-article-id={it.whySource.id}>
                      Source
                    </a>
                  )}
                </p>
              )}
              {it.confidence && <p className="m-0 text-sm text-muted">{it.confidence}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 mt-2 text-xs text-muted">{note}</p>
    </section>
  );
}
