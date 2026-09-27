'use client';

import type { DecimalInput } from '@kora/domain';

import { cx } from '../lib/cx';
import { direction, formatMoney, formatPrice, type MoneyOptions } from '../format/format';

export interface MoneyProps extends MoneyOptions {
  amount: DecimalInput;
  currency: string;
  /** Colour by sign (P&L). Sign characters are always shown when signed. */
  colored?: boolean;
  className?: string;
}

export function Money({ amount, currency, colored, className, ...opts }: MoneyProps) {
  const dir = direction(amount);
  return (
    <span
      className={cx('k-num', colored && `k-dir--${dir}`, className)}
      data-direction={colored ? dir : undefined}
    >
      {formatMoney(amount, currency, opts)}
    </span>
  );
}

export interface PriceProps {
  value: DecimalInput;
  /** Instrument price precision from the registry. */
  precision: number;
  className?: string;
}

export function Price({ value, precision, className }: PriceProps) {
  return <span className={cx('k-num', className)}>{formatPrice(value, precision)}</span>;
}
