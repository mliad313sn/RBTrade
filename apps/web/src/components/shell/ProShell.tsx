'use client';

import { EnvChip, Kbd } from '@kora/ui';
import { Search, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { KillSwitch } from './KillSwitch';
import { LeftRail } from './LeftRail';
import { ModeToggle } from './ModeToggle';
import { StatusBar } from './StatusBar';
import { UserMenu } from './UserMenu';
import { WhatChangedNote } from './WhatChangedNote';

function AccountSummary() {
  // Values come from the paper engine in goal 03. Until then they are explicitly unavailable.
  const items = ['Equity', 'Day P&L', 'Margin used', 'Daily loss limit'];
  return (
    <dl className="hidden xl:flex items-center gap-6 m-0" aria-label="Account summary (available with the trading core)" data-testid="account-summary">
      {items.map((label) => (
        <div key={label} className="flex flex-col">
          <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
          <dd className="m-0 k-num text-sm" title="Available once the paper engine is connected">
            —
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ProShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col h-screen min-h-0">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="k-hazard" aria-hidden="true" />
      <header className="flex items-center gap-4 px-3 h-12 border-b border-border bg-bg" data-testid="pro-topbar">
        <Link href="/terminal" className="flex items-center gap-2 no-underline font-semibold tracking-wide" aria-label="KORA Pro home">
          <TrendingUp size={18} className="text-accent" aria-hidden="true" />
          <span>KORA</span>
          <span className="text-[10px] text-muted">PRO</span>
        </Link>
        <button
          type="button"
          className="hidden md:flex items-center gap-2 h-8 px-3 w-64 rounded border border-border bg-panel text-muted text-sm text-left cursor-pointer"
          aria-label="Open command palette (coming with the Pro terminal)"
          aria-keyshortcuts="Meta+K Control+K"
          data-testid="command-palette"
        >
          <Search size={14} aria-hidden="true" />
          <span className="flex-1">Symbol, action, screen…</span>
          <Kbd>⌘K</Kbd>
        </button>
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
          <main id="main" className="flex-1 min-h-0 overflow-auto p-2">
            {children}
          </main>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
