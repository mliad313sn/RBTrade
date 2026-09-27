'use client';

import { signed, type TrendCard } from '@/lib/intel/client';

/**
 * Feature-contribution bars (log-odds SHAP values of the trend model) drawn from the trend card's
 * data, never from model text. ▲ pushed towards the forecast direction's "up" probability, ▼ against.
 */
export function DriversChart({ card }: { card: TrendCard }) {
  if (!card.drivers.length)
    return (
      <p className="m-0 text-xs text-muted" data-testid="drivers-empty">
        No model drivers for this horizon (the forecast needs more SIMULATED history).
      </p>
    );
  const max = Math.max(...card.drivers.map((d) => Math.abs(d.contribution)), 1e-9);
  return (
    <figure
      className="m-0"
      data-testid="drivers-chart"
      aria-label={`Top drivers of the ${card.horizon} forecast for ${card.symbol}`}
    >
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
        {card.drivers.map((d) => {
          const w = Math.round((Math.abs(d.contribution) / max) * 100);
          const pos = d.contribution >= 0;
          return (
            <li
              key={d.feature}
              className="grid grid-cols-[minmax(0,1fr)_90px_72px] items-center gap-2"
              data-testid="driver-row"
            >
              <span className="truncate" title={`${d.label} = ${d.value}`}>
                {d.label} <span className="text-muted">({d.value})</span>
              </span>
              <span className="h-2 rounded bg-raised" aria-hidden="true">
                <span
                  className={`block h-2 rounded ${pos ? 'bg-up' : 'bg-down'}`}
                  style={{ width: `${w}%` }}
                />
              </span>
              <span className="k-num text-right">
                {pos ? '▲' : '▼'} {signed(d.contribution, 3)}
              </span>
            </li>
          );
        })}
      </ul>
      <figcaption className="mt-1 text-xs text-muted">
        Contributions to the log-odds of an up move (linear SHAP, from the stored forecast).
      </figcaption>
    </figure>
  );
}
