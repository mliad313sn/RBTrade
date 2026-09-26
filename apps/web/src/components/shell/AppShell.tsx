'use client';

import { resolveTheme } from '@kora/domain';
import type { MeResponse } from '@kora/sdk';
import { ToastProvider } from '@kora/ui';
import { useEffect, type ReactNode } from 'react';

import { NoviceShell } from './NoviceShell';
import { ProShell } from './ProShell';
import { ShellProvider, useShell } from './ShellContext';

function Themed({ children }: { children: ReactNode }) {
  const { me } = useShell();
  const theme = resolveTheme(me.preferences);
  const mode = me.preferences.viewMode;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colors = me.preferences.colourConvention;
  }, [theme, me.preferences.colourConvention]);
  return (
    <div data-theme={theme} data-colors={me.preferences.colourConvention} data-mode={mode} className="k-root min-h-screen">
      {mode === 'pro' ? <ProShell>{children}</ProShell> : <NoviceShell>{children}</NoviceShell>}
    </div>
  );
}

export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  return (
    <ShellProvider initialMe={me}>
      <ToastProvider>
        <Themed>{children}</Themed>
      </ToastProvider>
    </ShellProvider>
  );
}
