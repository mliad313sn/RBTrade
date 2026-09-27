'use client';

import { forwardRef, useId, type SelectHTMLAttributes } from 'react';

import { cx } from '../lib/cx';
import { describedBy, Field, type FieldProps } from './Input';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>,
    FieldProps {
  options: SelectOption[];
}

/** Native select: best keyboard, screen-reader and mobile support. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, hideLabel, id, options, className, ...rest },
  ref,
) {
  const auto = useId();
  const selectId = id ?? auto;
  return (
    <Field id={selectId} label={label} hint={hint} error={error} hideLabel={hideLabel}>
      <select
        ref={ref}
        id={selectId}
        className={cx('k-select', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(selectId, hint, error)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
});
