'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
}

export interface SegmentedControlProps<V extends string> {
  label: string;
  value: V;
  options: SegmentOption<V>[];
  onChange: (value: V) => void;
  className?: string;
  'data-testid'?: string;
}

/** Radio-group semantics with roving focus (arrow keys). Used for the Pro ⇄ Novice switch. */
export function SegmentedControl<V extends string>({ label, value, options, onChange, className, ...rest }: SegmentedControlProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const j = (i + delta + options.length) % options.length;
    refs.current[j]?.focus();
    onChange(options[j]!.value);
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx('k-seg', className)} {...rest}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="k-seg__opt"
            onClick={() => !checked && onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
