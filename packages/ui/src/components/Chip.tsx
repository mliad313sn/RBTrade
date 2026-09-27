'use client';

import type { HTMLAttributes } from 'react';

import { cx } from '../lib/cx';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'paper' | 'live' | 'ai' | 'warn';
}

export function Chip({ tone = 'neutral', className, ...rest }: ChipProps) {
  return (
    <span className={cx('k-chip', tone !== 'neutral' && `k-chip--${tone}`, className)} {...rest} />
  );
}

/** Environment chip. PAPER is always visible; LIVE is never enabled by this build. */
export function EnvChip({ env, label }: { env: 'PAPER' | 'LIVE'; label?: string }) {
  return (
    <Chip
      tone={env === 'PAPER' ? 'paper' : 'live'}
      role="status"
      aria-label={`Trading environment: ${env === 'PAPER' ? 'paper (simulated money)' : 'live'}`}
      data-testid="env-chip"
    >
      {label ?? env}
    </Chip>
  );
}
