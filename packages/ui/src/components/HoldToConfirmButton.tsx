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
import { Button, type ButtonVariant } from './Button';
import { Dialog } from './Dialog';

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

/** Every user-facing string of the primitive, so callers can localise it (IRTC R5-04). */
export interface HoldLabels {
  /** Accessible instruction; receives the hold duration already formatted for the locale. */
  instruction: (seconds: string) => string;
  holding: string;
  confirmed: string;
  /** Title of the confirm step opened by a single activation (screen reader, voice control, tap). */
  confirmTitle: string;
  confirmBody: string;
  confirm: string;
  cancel: string;
}

export const DEFAULT_HOLD_LABELS: HoldLabels = {
  instruction: (s) => `Press and hold for ${s} seconds to confirm, or activate once to confirm in a dialog.`,
  holding: 'Holding…',
  confirmed: 'Confirmed',
  confirmTitle: 'Confirm this action',
  confirmBody: 'You can also press and hold the button to confirm directly.',
  confirm: 'Confirm',
  cancel: 'Cancel',
};

/**
 * A release within this time counts as a tap (opens the confirm step); a longer press released early
 * is an aborted hold and does nothing. Capped at half the hold for short holds.
 */
const TAP_MS = 350;

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
  /** Localised strings (defaults are English). */
  labels?: Partial<HoldLabels>;
  /** Locale used to format the hold duration (e.g. "1,5" in French). */
  locale?: string;
  /** Title of the built-in confirm step (overrides `labels.confirmTitle`). */
  confirmTitle?: string;
  /**
   * Called on a single activation (click from assistive tech, voice control, switch access, or a short
   * tap) instead of opening the built-in confirm dialog, when the caller's next step is already an
   * explicit confirmation (e.g. the kill-switch scope menu).
   */
  onActivate?: () => void;
  'data-testid'?: string;
}

/**
 * Press-and-hold confirmation for irreversible actions. Works with mouse, touch, pen (pointer
 * events) and keyboard (Space or Enter held down). Releasing a long press early cancels.
 *
 * IRTC R5-04: a single activation (a click dispatched by a screen reader, voice control or switch
 * access, a short tap, or a short Enter/Space press) opens an explicit confirm step (a dialog with a
 * Confirm button, or the caller's `onActivate`), so the action never depends on holding alone
 * (WCAG 2.1.1, 2.5.1, 4.1.2).
 */
export const HoldToConfirmButton = forwardRef<HoldHandle, HoldToConfirmButtonProps>(function HoldToConfirmButton(
  { children, onConfirm, holdMs = 1500, variant = 'danger', size = 'md', disabled, className, description, labels, locale = 'en', confirmTitle, onActivate, ...rest },
  ref,
) {
  const L: HoldLabels = { ...DEFAULT_HOLD_LABELS, ...labels };
  const btn = useRef<HTMLButtonElement>(null);
  const descId = useId();
  const [announce, setAnnounce] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Set when a hold completed, so the click that follows the release is ignored. */
  const completed = useRef(false);
  /** When the current press started (pointer or key), to tell a tap from an aborted hold. */
  const pressedAt = useRef<number | null>(null);
  const setProgress = useCallback((r: number) => {
    btn.current?.style.setProperty('--k-hold-progress', String(r));
  }, []);
  const { holding, start, cancel } = useHold({
    holdMs,
    disabled,
    onProgress: setProgress,
    onConfirm: () => {
      completed.current = true;
      pressedAt.current = null;
      setAnnounce(L.confirmed);
      onConfirm();
    },
  });
  useImperativeHandle(ref, () => ({ start, cancel }), [start, cancel]);
  const seconds = (holdMs / 1000).toLocaleString(locale, { maximumFractionDigits: 1 });

  const press = () => {
    completed.current = false;
    pressedAt.current = performance.now();
    start();
  };
  /** True when the press that just ended was short enough to be a tap. */
  const wasTap = () => pressedAt.current !== null && performance.now() - pressedAt.current < Math.min(TAP_MS, holdMs / 2);
  const activate = () => {
    if (disabled) return;
    cancel();
    if (onActivate) onActivate();
    else setConfirmOpen(true);
  };

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
          press();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onLostPointerCapture={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onClick={(e) => {
          // The click that follows a completed hold: already confirmed.
          if (completed.current) {
            completed.current = false;
            pressedAt.current = null;
            return;
          }
          // detail 0 = activation without a pointer press (screen reader, voice control, switch access).
          const tap = e.detail === 0 || wasTap();
          pressedAt.current = null;
          if (tap) activate();
        }}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (!e.repeat) press();
          } else if (e.key === 'Escape') {
            cancel();
            pressedAt.current = null;
          }
        }}
        onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            const tap = !completed.current && wasTap();
            completed.current = false;
            pressedAt.current = null;
            if (tap) activate();
            else cancel();
          }
        }}
        onBlur={cancel}
        {...rest}
      >
        <span className="k-hold__fill" aria-hidden="true" />
        {children}
      </button>
      <span id={descId} className="k-sr-only">
        {`${L.instruction(seconds)}${description ? ` ${description}` : ''}`}
      </span>
      <span className="k-sr-only" role="status" aria-live="polite">
        {holding ? L.holding : announce}
      </span>
      {onActivate ? null : (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen} alert title={confirmTitle ?? L.confirmTitle} description={L.confirmBody}>
          <div className="k-dialog__actions">
            <Button onClick={() => setConfirmOpen(false)} autoFocus>
              {L.cancel}
            </Button>
            <Button
              variant={variant}
              onClick={() => {
                setConfirmOpen(false);
                setAnnounce(L.confirmed);
                onConfirm();
              }}
              data-testid={rest['data-testid'] ? `${rest['data-testid']}-confirm` : undefined}
            >
              {L.confirm}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
});
