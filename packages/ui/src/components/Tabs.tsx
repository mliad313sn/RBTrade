'use client';

import * as RTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  label: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  className?: string;
}

export function Tabs({ items, label, value, defaultValue, onValueChange, className }: TabsProps) {
  return (
    <RTabs.Root
      className={cx('k-tabs', className)}
      value={value}
      defaultValue={defaultValue ?? items[0]?.value}
      onValueChange={onValueChange}
    >
      <RTabs.List className="k-tabs__list" aria-label={label}>
        {items.map((t) => (
          <RTabs.Trigger key={t.value} value={t.value} disabled={t.disabled} className="k-tab">
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map((t) => (
        <RTabs.Content key={t.value} value={t.value} className="k-tabs__content">
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}
