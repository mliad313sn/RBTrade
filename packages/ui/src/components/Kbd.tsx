'use client';

import type { HTMLAttributes } from 'react';

import { cx } from '../lib/cx';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx('k-kbd', className)} {...rest} />;
}
