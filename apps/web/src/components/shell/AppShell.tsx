'use client';

import { resolveTheme } from '@kora/domain';
import type { DisclosureDocument, MeResponse } from '@kora/sdk';
import { ToastProvider } from '@kora/ui';
import dynamic from 'next/dynamic';
import { useEffect, type ReactNode } from 'react';

import { usePathname } from 'next/navigation';

import type { Locale } from '@/lib/i18n';
import { I18nProvider } from '@/lib/i18n/react';
import { isGovernanceRoute } from '@/lib/modes';
import { ExplainModeProvider, type ExplainMode } from '@/lib/novice/explain-slot';

import { NoviceShell } from './NoviceShell';
import { ShellProvider, useShell } from './ShellContext';

// The Pro shell (command palette, registry search) is its own chunk, so the Novice view (mobile
// first, Lighthouse budget) does not download it.
const ProShell = dynamic(() => import('./ProShell').then((m) => m.ProShell));

interface ShellExtras {
  locale: Locale;
  disclosure: DisclosureDocument | null;
  explainMode: ExplainMode;
}

function Themed({ children, locale, disclosure, explainMode }: { children: ReactNode } & ShellExtras) {
  const { me } = useShell();
  const pathname = usePathname();
  // IRTC R5-25: second- and third-line screens (risk console, internal audit, administration) belong to
  // the Pro shell whatever the viewer's preferred view, so a risk officer never sees them under the
  // retail banner and novice navigation.
  const mode = isGovernanceRoute(pathname) ? 'pro' : me.preferences.viewMode;
  const theme = resolveTheme({ ...me.preferences, viewMode: mode });
  // Goal 08: the Novice view speaks the viewer's language; Pro screens stay in English.
  const lang: Locale = mode === 'novice' ? locale : 'en';
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colors = me.preferences.colourConvention;
    document.documentElement.dataset.mode = mode;
    document.documentElement.lang = lang;
  }, [theme, me.preferences.colourConvention, lang, mode]);
  return (
    <I18nProvider locale={lang} novice={mode === 'novice'}>
      <div data-theme={theme} data-colors={me.preferences.colourConvention} data-mode={mode} className="k-root min-h-screen">
        {mode === 'pro' ? (
          <ProShell>{children}</ProShell>
        ) : (
          <ExplainModeProvider mode={explainMode}>
            <NoviceShell disclosure={disclosure}>{children}</NoviceShell>
          </ExplainModeProvider>
        )}
      </div>
    </I18nProvider>
  );
}

export function AppShell({ me, children, ...extras }: { me: MeResponse; children: ReactNode } & ShellExtras) {
  return (
    <ShellProvider initialMe={me}>
      <ToastProvider>
        <Themed {...extras}>{children}</Themed>
      </ToastProvider>
    </ShellProvider>
  );
}
