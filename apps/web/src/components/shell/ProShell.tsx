'use client';

import { EnvChip } from '@kora/ui';
import { TrendingUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AccountSummary } from './AccountSummary';
import { CommandPalette } from './CommandPalette';
import { KillSwitch } from './KillSwitch';
import { LeftRail } from './LeftRail';
import { ModeToggle } from './ModeToggle';
import { StatusBar } from './StatusBar';
import { ProRiskWarningBanner } from './ProRiskWarningBanner';
import { TradingHaltBanner } from './TradingHaltBanner';
import { UserMenu } from './UserMenu';
import { WhatChangedNote } from './WhatChangedNote';

export function ProShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col h-screen min-h-0">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="k-hazard" aria-hidden="true" />
      <header className="flex items-center gap-4 px-3 h-[37px] border-b border-border bg-bg" data-testid="pro-topbar">
        <Link href="/terminal" className="flex items-center gap-2 no-underline font-semibold tracking-wide" aria-label="KORA Pro home">
          <TrendingUp size={18} className="text-accent" aria-hidden="true" />
          <span>KORA</span>
          <span className="text-[10px] text-muted">PRO</span>
        </Link>
        <CommandPalette />
        <EnvChip env="PAPER" />
        <AccountSummary />
        <div className="ml-auto flex items-center gap-3">
          <ModeToggle />
          <KillSwitch />
          <UserMenu />
        </div>
      </header>
      <div className="flex flex-1 min-h-0">
        <LeftRail />
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <WhatChangedNote />
          <TradingHaltBanner className="px-2 pt-2" />
          <ProRiskWarningBanner className="px-2 pt-2" />
          <main id="main" className="flex-1 min-h-0 overflow-auto p-2 pl-[7px]">
            {children}
          </main>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
