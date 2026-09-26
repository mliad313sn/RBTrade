'use client';

import { Banner, Chip } from '@kora/ui';
import { BookOpen, Home, Repeat, Sprout } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { NOVICE_NAV } from '@/lib/modes';

import { KillSwitch } from './KillSwitch';
import { ModeToggle } from './ModeToggle';
import { TradingHaltBanner } from './TradingHaltBanner';
import { UserMenu } from './UserMenu';
import { WhatChangedNote } from './WhatChangedNote';

const ICONS: Record<string, typeof Home> = { '/home': Home, '/practice': Sprout, '/auto-invest': Repeat, '/learn': BookOpen };

function useActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(`${href}/`);
}

export function NoviceShell({ children }: { children: ReactNode }) {
  const active = useActive();
  return (
    <div className="min-h-screen flex flex-col pb-20 md:pb-0">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 md:px-10 py-3 md:min-h-18 border-b border-border bg-panel" data-testid="novice-topbar">
        <Link href="/home" className="flex items-center gap-2 no-underline" aria-label="Kora home">
          <span className="text-accent text-xl" aria-hidden="true">
            ↗
          </span>
          <span className="font-display text-2xl">Kora</span>
        </Link>
        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex gap-2 list-none m-0 p-0">
            {NOVICE_NAV.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={active(n.href) ? 'page' : undefined}
                  className={`inline-flex items-center h-11 px-4 rounded-full no-underline text-[15px] ${active(n.href) ? 'bg-up-surface text-accent font-semibold' : 'text-text hover:bg-raised'}`}
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <Chip tone="paper" role="status" aria-label="Trading environment: practice money (paper)" data-testid="env-chip">
            Practice money
          </Chip>
          <ModeToggle />
          <KillSwitch compact />
          <UserMenu />
        </div>
      </header>
      <div className="px-4 md:px-10 pt-5">
        <Banner tone="warn" title="Trading can lose you money." action={<Link href="/learn" className="text-accent font-semibold whitespace-nowrap">Read the risks</Link>}>
          [XX]% of retail accounts lose money trading with this provider. You&apos;re using practice money, so nothing real is at risk yet.
        </Banner>
      </div>
      <WhatChangedNote className="px-4 md:px-10 pt-3" />
      <TradingHaltBanner className="px-4 md:px-10 pt-3" />
      <main id="main" className="flex-1 px-4 md:px-10 py-5">
        {children}
      </main>
      <nav aria-label="Main (mobile)" className="md:hidden fixed bottom-0 inset-x-0 border-t border-border bg-panel" data-testid="mobile-tabbar">
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
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
