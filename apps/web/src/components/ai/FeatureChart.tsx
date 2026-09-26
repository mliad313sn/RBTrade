'use client';

import type { SignalFeatures } from '@/lib/ai/client';

function signed(x: number): string {
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}`;
}

/**
 * Feature-contribution bars for one signal, drawn from `GET /signals/:id/features` (stored data),
 * never from model text. Positive = pushed towards the decision (▲), negative = against (▼).
 */
export function FeatureChart({ features }: { features: SignalFeatures }) {
  const rows = features.conditions;
  return (
    <figure
      className="ai-fc m-0"
      data-testid="feature-chart"
      aria-label={`Feature contributions for ${features.action.replace('_', ' ')} ${features.symbol}`}
    >
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
        {rows.map((c, i) => {
          const v = c.contribution;
          const width = v === null ? 0 : Math.round(Math.min(1, Math.abs(v)) * 100);
          return (
            <li key={`${c.label}-${i}`} className="ai-fc__row" data-testid="feature-row">
              <span className="truncate" title={c.label}>
                {c.label}
              </span>
              <span className="ai-fc__track" aria-hidden="true">
                <span
                  className={`ai-fc__bar ${v !== null && v < 0 ? 'is-neg' : ''}`}
                  style={{ width: `${width}%` }}
                />
              </span>
              <span className="k-num text-right" data-testid="feature-value">
                {v === null
                  ? c.result === 'not_available'
                    ? 'n/a'
                    : '—'
                  : `${v >= 0 ? '▲' : '▼'} ${signed(v)}`}
              </span>
            </li>
          );
        })}
      </ul>
      <figcaption className="mt-1 text-xs text-muted">
        From the values stored with the decision ({features.barTs.slice(0, 16).replace('T', ' ')}{' '}
        UTC). {features.explanation ?? ''}
      </figcaption>
    </figure>
  );
}
