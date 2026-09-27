'use client';

import { quoteBadge, sessionBadge } from '@kora/domain';

/** Venue MIC + session state (B-208). Text, not colour alone. */
export function SessionBadge({
  mic,
  state,
  className = '',
}: {
  mic: string;
  state: string | null | undefined;
  className?: string;
}) {
  const b = sessionBadge(state);
  return (
    <span
      className={`k-session k-session--${b.tone} ${className}`}
      data-session={state ?? 'unknown'}
      title={`${mic}: ${b.label}`}
    >
      <span aria-hidden="true">●</span>
      <span>
        {mic} · {b.label}
      </span>
    </span>
  );
}

/** "Stale" only while the market is open; "Closed" otherwise (a closed market's quote is just old). */
export function QuoteStateBadge({
  stale,
  session,
  testId,
}: {
  stale: boolean;
  session: string | null | undefined;
  testId?: string;
}) {
  const b = quoteBadge({ stale, session });
  if (!b) return null;
  return (
    <span
      className={`k-qbadge k-qbadge--${b}`}
      data-testid={testId}
      title={
        b === 'stale'
          ? 'No fresh quote within the staleness threshold'
          : 'Market closed: last quote shown'
      }
    >
      {b === 'stale' ? 'Stale' : 'Closed'}
    </span>
  );
}
