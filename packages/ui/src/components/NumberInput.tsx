'use client';

import { dec, isDecimalString, quantize } from '@kora/domain';
import { forwardRef, useId, type InputHTMLAttributes, type KeyboardEvent } from 'react';

import { cx } from '../lib/cx';
import { describedBy, Field, type FieldProps } from './Input';

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step' | 'size'>,
    FieldProps {
  /** Decimal string. Never a JS number. */
  value: string;
  onValueChange: (value: string) => void;
  /** Max decimal places (instrument precision). */
  precision: number;
  min?: string;
  max?: string;
  /** Step for ArrowUp/ArrowDown, as a decimal string (e.g. tick size). */
  step?: string;
  allowNegative?: boolean;
}

/** Characters a user may type while editing (partial decimals like "1." or "-" are allowed). */
export function isPartialDecimal(s: string, precision: number, allowNegative: boolean): boolean {
  const sign = allowNegative ? '-?' : '';
  const frac = precision > 0 ? `(\\.\\d{0,${precision}})?` : '';
  return new RegExp(`^${sign}\\d*${frac}$`).test(s);
}

function clamp(v: string, min?: string, max?: string): string {
  let d = dec(v);
  if (min !== undefined && d.lt(dec(min))) d = dec(min);
  if (max !== undefined && d.gt(dec(max))) d = dec(max);
  return d.toString();
}

/** Normalises a finished value to exactly `precision` places, within [min, max]. */
export function normaliseDecimal(raw: string, precision: number, min?: string, max?: string): string {
  const s = raw.trim();
  if (s === '' || s === '-' || s === '.' || s === '-.') return '';
  const fixed = s.endsWith('.') ? s.slice(0, -1) : s.startsWith('.') ? `0${s}` : s.replace(/^-\./, '-0.');
  if (!isDecimalString(fixed)) return '';
  return quantize(clamp(fixed, min, max), precision).toFixed(precision);
}

/**
 * Decimal-safe numeric input: keeps a string, validates against instrument precision, steps with
 * Decimal maths. There is no parseFloat anywhere in this component.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { label, hint, error, hideLabel, id, value, onValueChange, precision, min, max, step, allowNegative = false, className, onBlur, onKeyDown, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;

  const stepBy = (dir: 1 | -1, e: KeyboardEvent<HTMLInputElement>) => {
    if (!step) return;
    e.preventDefault();
    const base = isDecimalString(value) ? value : (min ?? '0');
    const next = dec(base).plus(dec(step).mul(dir));
    if (!allowNegative && next.isNegative()) return;
    onValueChange(normaliseDecimal(next.toString(), precision, min, max));
  };

  return (
    <Field id={inputId} label={label} hint={hint} error={error} hideLabel={hideLabel}>
      <input
        ref={ref}
        id={inputId}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className={cx('k-input', 'k-input--num', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        value={value}
        onChange={(e) => {
          const next = e.target.value.replace(',', '.');
          if (isPartialDecimal(next, precision, allowNegative)) onValueChange(next);
        }}
        onBlur={(e) => {
          const n = normaliseDecimal(value, precision, min, max);
          if (n !== value) onValueChange(n);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') stepBy(1, e);
          else if (e.key === 'ArrowDown') stepBy(-1, e);
          onKeyDown?.(e);
        }}
        {...rest}
      />
    </Field>
  );
});
