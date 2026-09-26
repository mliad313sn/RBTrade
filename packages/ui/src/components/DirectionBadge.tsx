'use client';

import type { DecimalInput } from '@kora/domain';

import { cx } from '../lib/cx';
import { direction, formatDecimal, formatPercent, spokenDirection } from '../format/format';

export interface DirectionBadgeProps {
  /** Signed change as a decimal string. Direction comes from its sign. */
  value: DecimalInput;
  /** 'percent' treats value as a ratio (0.0018 → +0.18%). */
  format?: 'number' | 'percent';
  decimals?: number;
  suffix?: string;
  className?: string;
}

const ARROW = { up: '▲', down: '▼', flat: '–' } as const;

/** Colour is never the only cue: arrow + sign + colour, and a spoken label. */
export function DirectionBadge({ value, format = 'number', decimals = 2, suffix, className }: DirectionBadgeProps) {
  const dir = direction(value);
  const text = format === 'percent' ? formatPercent(value, decimals) : formatDecimal(value, decimals, { signed: true });
  const spoken = `${spokenDirection(value)} ${text.replace(/^[+−]/, '')}${suffix ? ` ${suffix}` : ''}`;
  return (
    <span className={cx('k-dir', `k-dir--${dir}`, className)} data-direction={dir}>
      <span aria-hidden="true">{ARROW[dir]}</span>
      <span aria-hidden="true">
        {text}
        {suffix ? ` ${suffix}` : ''}
      </span>
      <span className="k-sr-only">{spoken}</span>
    </span>
  );
}
