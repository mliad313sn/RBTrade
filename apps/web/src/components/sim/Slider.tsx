'use client';

import { useId } from 'react';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display: (v: number) => string;
  hint?: string;
  testId?: string;
}

/** Labelled range input (native: keyboard, screen reader and touch support for free). */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
  hint,
  testId,
}: SliderProps) {
  const id = useId();
  const shown = display(value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={id}
          className="text-[11px] uppercase tracking-wider text-muted font-semibold"
        >
          {label}
        </label>
        <output htmlFor={id} className="k-num text-sm">
          {shown}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="w-full h-6 cursor-pointer accent-[var(--k-accent)]"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={shown}
        aria-describedby={hint ? `${id}-hint` : undefined}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? (
        <span id={`${id}-hint`} className="text-[11px] text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
