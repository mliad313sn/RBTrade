'use client';

import type { DisclosureDocument } from '@kora/sdk';
import { Banner, Chip } from '@kora/ui';
import { BookOpen, Bot, Home, Sprout } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { LanguageSwitch } from '@/components/novice/LanguageSwitch';
import { PricesPausedBanner, PwaRegister } from '@/components/novice/Pwa';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/react';
import { isProRoute, NOVICE_NAV } from '@/lib/modes';
import { NoviceExplainThis } from '@/lib/novice/explain-copilot';
import { registerExplainThis } from '@/lib/novice/explain-slot';

import { KillSwitch } from './KillSwitch';
import { ModeToggle } from './ModeToggle';
import { ProRouteNotice } from './ProRouteNotice';
import { TradingHaltBanner } from './TradingHaltBanner';
import { UserMenu } from './UserMenu';
import { WhatChangedNote } from './WhatChangedNote';

// Goal 07's novice copilot fills goal 08's "Explain this to me" slot (shown when KORA_EXPLAIN_THIS=on).
registerExplainThis(NoviceExplainThis);

const ICONS: Record<string, typeof Home> = { '/home': Home, '/practice': Sprout, '/auto-invest': Bot, '/learn': BookOpen };
const LABELS: Record<string, MessageKey> = {
  '/home': 'nav.home',
  '/practice': 'nav.practice',
  '/auto-invest': 'nav.autoInvest',
  '/learn': 'nav.learn',
};

function useActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Novice shell (goal 01, localised and made mobile-first in goal 08): 390 px-first, bottom tab bar
 * on phones, 44 px targets, the regulatory banner from the disclosures registry, and the
 * "prices paused" offline state. No streaks, badges, confetti or trading nudges.
 */
export function NoviceShell({ children, disclosure }: { children: ReactNode; disclosure: DisclosureDocument | null }) {
  const active = useActive();
  const pathname = usePathname();
  const { t } = useI18n();
  return (
    <div className="min-h-screen flex flex-col pb-24 md:pb-0">
      <PwaRegister />
      <a href="#main" className="skip-link">
        {t('shell.skip')}
      </a>
      <header
        className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 md:px-10 py-2 md:py-3 md:min-h-18 border-b border-border bg-panel"
        data-testid="novice-topbar"
      >
        <Link href="/home" className="flex items-center gap-2 no-underline min-h-11" aria-label={t('shell.homeLink')}>
          <span className="text-accent text-xl" aria-hidden="true">
            ↗
          </span>
          <span className="font-display text-2xl">Kora</span>
        </Link>
        <nav aria-label={t('shell.nav.main')} className="hidden md:block">
          <ul className="flex gap-2 list-none m-0 p-0">
            {NOVICE_NAV.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={active(n.href) ? 'page' : undefined}
                  className={`inline-flex items-center h-11 px-4 rounded-full no-underline text-[15px] ${active(n.href) ? 'bg-accent-surface text-accent font-semibold' : 'text-text hover:bg-raised'}`}
                >
                  {t(LABELS[n.href] ?? 'nav.home')}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {/* Phones: row 1 = logo, practice chip, language, account; row 2 = view and stop (always
            visible). IRTC R5-26: the practice-money chip stays on phones in a short form, so PAPER is
            always visible after scrolling past the banner (master goal). */}
        <div className="ml-auto md:ml-0 flex flex-wrap items-center justify-end gap-2 md:order-last">
          <Chip tone="paper" role="status" aria-label={t('shell.envAria')} data-testid="env-chip">
            <span className="max-sm:hidden">{t('shell.env')}</span>
            <span className="sm:hidden">{t('shell.envShort')}</span>
          </Chip>
          <LanguageSwitch />
          <UserMenu />
        </div>
        <div className="flex items-center gap-2 md:gap-3 md:ml-auto max-md:basis-full max-md:justify-between">
          <ModeToggle />
          <KillSwitch compact />
        </div>
      </header>
      <div className="px-4 md:px-10 pt-4 md:pt-5" data-testid="risk-banner">
        <Banner
          tone="warn"
          title={t('shell.banner.title')}
          action={
            <Link href="/learn#risks" className="text-accent font-semibold whitespace-nowrap inline-flex items-center min-h-11">
              {t('shell.banner.read')}
            </Link>
          }
        >
          {disclosure?.banner ?? t('shell.banner.placeholder')}
        </Banner>
      </div>
      <PricesPausedBanner className="px-4 md:px-10 pt-3" />
      <WhatChangedNote className="px-4 md:px-10 pt-3" />
      <TradingHaltBanner className="px-4 md:px-10 pt-3" />
      <main id="main" className="flex-1 px-4 md:px-10 py-4 md:py-5">
        {isProRoute(pathname) ? <ProRouteNotice /> : children}
      </main>
      <nav
        aria-label={t('shell.nav.mobile')}
        className="md:hidden fixed bottom-0 inset-x-0 border-t border-border bg-panel pb-[env(safe-area-inset-bottom)]"
        data-testid="mobile-tabbar"
      >
        <ul className="grid grid-cols-4 list-none m-0 p-0">
          {NOVICE_NAV.map((n) => {
            const Icon = ICONS[n.href] ?? Home;
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={active(n.href) ? 'page' : undefined}
                  className={`flex flex-col items-center justify-center gap-1 min-h-16 no-underline text-[13px] ${active(n.href) ? 'text-accent font-semibold' : 'text-muted'}`}
                >
                  <Icon size={20} aria-hidden="true" />
                  {t(LABELS[n.href] ?? 'nav.home')}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
