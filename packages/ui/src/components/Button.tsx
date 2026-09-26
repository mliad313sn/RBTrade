'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export type ButtonVariant = 'secondary' | 'primary' | 'buy' | 'sell' | 'ghost' | 'danger' | 'danger-solid';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('k-btn', `k-btn--${variant}`, size !== 'md' && `k-btn--${size}`, block && 'k-btn--block', className)}
      {...rest}
    />
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label'> {
  /** Accessible name is mandatory for icon-only buttons. */
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, variant = 'ghost', ...rest },
  ref,
) {
  return (
    <Button ref={ref} aria-label={label} title={label} variant={variant} className={cx('k-icon-btn', className)} {...rest}>
      <span aria-hidden="true">{icon}</span>
    </Button>
  );
});
