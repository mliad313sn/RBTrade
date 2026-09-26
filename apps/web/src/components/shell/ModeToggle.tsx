'use client';

import type { ViewMode } from '@kora/domain';
import { SegmentedControl, useToast } from '@kora/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { api } from '@/lib/api-browser';
import { counterpartPath } from '@/lib/modes';

import { useShell } from './ShellContext';

/** Pro ⇄ Novice switch. Persists per user (server), keeps account + instrument, then navigates. */
export function ModeToggle() {
  const { me, setMe } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toast = useToast();
  const [pending, start] = useTransition();
  const mode = me.preferences.viewMode;

  const change = (target: ViewMode) => {
    if (target === mode || pending) return;
    start(async () => {
      try {
        const r = await api.updatePreferences({ viewMode: target });
        setMe({ ...me, preferences: r.preferences, capabilities: r.capabilities });
        router.push(counterpartPath(pathname, target, search.toString()));
        router.refresh();
      } catch {
        toast.push('Could not switch view. Please try again.', 'critical');
      }
    });
  };

  return (
    <SegmentedControl
      data-testid="mode-toggle"
      label="View mode"
      value={mode}
      onChange={change}
      options={
        mode === 'novice'
          ? [
              { value: 'novice', label: 'Simple' },
              { value: 'pro', label: 'Pro' },
            ]
          : [
              { value: 'pro', label: 'Pro' },
              { value: 'novice', label: 'Novice' },
            ]
      }
    />
  );
}
