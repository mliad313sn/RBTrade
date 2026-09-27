'use client';

import * as RDialog from '@radix-ui/react-dialog';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Role alertdialog for destructive confirmations. */
  alert?: boolean;
  'data-testid'?: string;
}

/**
 * Modal dialog. Most KORA dialogs open from a hold, a hotkey or a drag (no Radix trigger), so the
 * element that had focus when the dialog opened is remembered and gets focus back on close
 * (WCAG 2.4.3; goal 10 keyboard walkthrough finding).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  alert,
  ...rest
}: DialogProps) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && typeof document !== 'undefined')
      opener.current = document.activeElement as HTMLElement | null;
  }, [open]);
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="k-dialog__overlay" />
        <RDialog.Content
          className="k-dialog"
          role={alert ? 'alertdialog' : 'dialog'}
          onCloseAutoFocus={(e) => {
            const el = opener.current;
            if (el && el.isConnected && el !== document.body) {
              e.preventDefault();
              el.focus();
            }
          }}
          {...rest}
        >
          <RDialog.Title className="k-dialog__title">{title}</RDialog.Title>
          {description ? (
            <RDialog.Description className="k-dialog__desc">{description}</RDialog.Description>
          ) : (
            <RDialog.Description className="k-sr-only">{title}</RDialog.Description>
          )}
          {children}
          {actions ? <div className="k-dialog__actions">{actions}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const DialogClose = RDialog.Close;
