'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { cx } from '../lib/cx';
import type { ButtonVariant } from './Button';

export interface HoldHandle {
  /** Start holding programmatically (e.g. hotkey keydown). */
  start: () => void;
  /** Cancel an in-progress hold (e.g. hotkey keyup). */
  cancel: () => void;
}

export interface UseHoldOptions {
  holdMs: number;
  onConfirm: () => void;
  onProgress?: (ratio: number) => void;
  disabled?: boolean;
}

/**
 * Hold state machine shared by the button and hotkeys. Completion uses setTimeout (deterministic
 * and testable); progress uses requestAnimationFrame for the visual fill only.
 */
export function useHold({ holdMs, onConfirm, onProgress, disabled }: UseHoldOptions) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef<number | null>(null);
  const startedAt = useRef(0);
  const confirmRef = useRef(onConfirm);
  const progressRef = useRef(onProgress);
  confirmRef.current = onConfirm;
  progressRef.current = onProgress;

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (raf.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf.current);
    timer.current = null;
    raf.current = null;
  }, []);

  const cancel = useCallback(() => {
    if (!timer.current) return;
    clear();
    setHolding(false);
    progressRef.current?.(0);
  }, [clear]);

  const start = useCallback(() => {
    if (disabled || timer.current) return;
    startedAt.current = performance.now();
    setHolding(true);
    const tick = () => {
      const ratio = Math.min(1, (performance.now() - startedAt.current) / holdMs);
      progressRef.current?.(ratio);
      if (ratio < 1 && typeof requestAnimationFrame === 'function') raf.current = requestAnimationFrame(tick);
    };
    tick();
    timer.current = setTimeout(() => {
      clear();
      setHolding(false);
      progressRef.current?.(0);
      confirmRef.current();
    }, holdMs);
  }, [clear, disabled, holdMs]);

  useEffect(() => clear, [clear]);
  return { holding, start, cancel };
}

export interface HoldToConfirmButtonProps {
  children: ReactNode;
  onConfirm: () => void;
  /** Hold duration in ms. Kill switch = 1500. */
  holdMs?: number;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  className?: string;
  /** Extra hint for assistive tech; the hold instruction is always announced. */
  description?: string;
  'data-testid'?: string;
}

/**
 * Press-and-hold confirmation for irreversible actions. Works with mouse, touch, pen (pointer
 * events) and keyboard (Space or Enter held down). Releasing early cancels.
 */
export const HoldToConfirmButton = forwardRef<HoldHandle, HoldToConfirmButtonProps>(function HoldToConfirmButton(
  { children, onConfirm, holdMs = 1500, variant = 'danger', size = 'md', disabled, className, description, ...rest },
  ref,
) {
  const btn = useRef<HTMLButtonElement>(null);
  const descId = useId();
  const [announce, setAnnounce] = useState('');
  const setProgress = useCallback((r: number) => {
    btn.current?.style.setProperty('--k-hold-progress', String(r));
  }, []);
  const { holding, start, cancel } = useHold({
    holdMs,
    disabled,
    onProgress: setProgress,
    onConfirm: () => {
      setAnnounce('Confirmed');
      onConfirm();
    },
  });
  useImperativeHandle(ref, () => ({ start, cancel }), [start, cancel]);
  const seconds = (holdMs / 1000).toLocaleString('en', { maximumFractionDigits: 1 });

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cx('k-btn', `k-btn--${variant}`, size !== 'md' && `k-btn--${size}`, 'k-hold', className)}
        data-holding={holding}
        aria-describedby={descId}
        disabled={disabled}
        onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
          if (e.button !== 0) return;
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            /* synthetic or already-released pointer: holding still works without capture */
          }
          start();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onLostPointerCapture={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (!e.repeat) start();
          } else if (e.key === 'Escape') {
            cancel();
          }
        }}
        onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={cancel}
        {...rest}
      >
        <span className="k-hold__fill" aria-hidden="true" />
        {children}
      </button>
      <span id={descId} className="k-sr-only">
        {`Press and hold for ${seconds} seconds to confirm.${description ? ` ${description}` : ''}`}
      </span>
      <span className="k-sr-only" role="status" aria-live="polite">
        {holding ? 'Holding…' : announce}
      </span>
    </>
  );
});
