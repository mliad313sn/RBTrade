import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-sans-condensed/400.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource-variable/fraunces';
import './globals.css';

import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { getLocale } from '@/lib/i18n/server';

// Per-request CSP nonces (middleware) require dynamic rendering for every page.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'KORA', template: '%s · KORA' },
  description: 'KORA trading platform — paper trading only.',
  robots: { index: false, follow: false },
  // Goal 08: installable PWA (app/manifest.ts); iOS home-screen title.
  appleWebApp: { capable: true, title: 'Kora', statusBarStyle: 'default' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0B0E13' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The Novice view is localised (EN/FR); the app shell corrects `lang` to "en" on Pro screens.
  const locale = await getLocale();
  // IRTC R5-26: the theme the app shell resolved last time (cookie written by AppShell), so a Novice
  // page is light from the first paint instead of dark until hydration. Unknown values fall back to dark.
  const themeCookie = (await cookies()).get('kora_theme')?.value;
  const theme = themeCookie === 'novice-light' ? 'novice-light' : 'pro-dark';
  return (
    <html lang={locale} data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
