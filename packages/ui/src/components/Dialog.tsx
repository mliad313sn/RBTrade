'use client';

import * as RDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

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

export function Dialog({ open, onOpenChange, title, description, children, actions, alert, ...rest }: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="k-dialog__overlay" />
        <RDialog.Content
          className="k-dialog"
          role={alert ? 'alertdialog' : 'dialog'}
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
