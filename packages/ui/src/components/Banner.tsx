'use client';

import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface BannerProps {
  tone?: 'info' | 'warn' | 'critical';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

const ICON = { info: 'ⓘ', warn: '⚠', critical: '⛔' } as const;

export function Banner({ tone = 'info', title, children, action, className }: BannerProps) {
  return (
    <div
      className={cx('k-banner', `k-banner--${tone}`, className)}
      role={tone === 'critical' ? 'alert' : 'status'}
    >
      <span className="k-banner__icon" aria-hidden="true">
        {ICON[tone]}
      </span>
      <div className="k-banner__body">
        {title ? <strong className="k-banner__title">{title}</strong> : null}
        {children}
      </div>
      {action}
    </div>
  );
}
