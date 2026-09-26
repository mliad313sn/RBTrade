'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from '@/lib/api-browser';
import { useI18n } from '@/lib/i18n/react';

import { useShell } from './ShellContext';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function UserMenu() {
  const { me } = useShell();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Goal 08: localised and 44 px in the Novice view; Pro text and size unchanged.
  const { t, novice } = useI18n();
  const tx = (en: string, key: Parameters<typeof t>[0], vars?: Record<string, string>) => (novice ? t(key, vars) : en);
  return (
    <div className="relative">
      <button
        type="button"
        className={`k-btn k-btn--ghost rounded-full! p-0! bg-raised! ${novice ? 'w-11 h-11' : 'w-9 h-9'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={tx(`Account menu for ${me.user.displayName}`, 'user.menu', { name: me.user.displayName })}
        onClick={() => setOpen((o) => !o)}
        data-testid="user-menu"
      >
        {initials(me.user.displayName) || 'ME'}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 mt-2 z-40 k-panel p-2 min-w-56 shadow-xl">
          <p className="text-xs text-muted px-2 py-1 m-0">
            {me.user.email} · {me.roles.join(', ')}
            {me.mfa ? ` · ${tx('2FA on', 'user.twoStepOn')}` : ''}
          </p>
          {!me.roles.includes('trader') ? (
            <Link role="menuitem" className="block px-2 py-2 rounded hover:bg-raised no-underline text-accent" href="/appropriateness" onClick={() => setOpen(false)} data-testid="unlock-pro">
              {tx('Unlock Pro trading', 'user.unlockPro')}
            </Link>
          ) : null}
          <Link role="menuitem" className="block px-2 py-2 rounded hover:bg-raised no-underline" href="/settings" onClick={() => setOpen(false)}>
            {tx('Settings', 'user.settings')}
          </Link>
          <Link role="menuitem" className="block px-2 py-2 rounded hover:bg-raised no-underline" href="/audit" onClick={() => setOpen(false)}>
            {tx('Audit log', 'user.audit')}
          </Link>
          <button
            role="menuitem"
            type="button"
            className="block w-full text-left px-2 py-2 rounded hover:bg-raised bg-transparent border-0 text-text cursor-pointer"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              router.replace('/login');
              router.refresh();
            }}
            data-testid="logout"
          >
            {tx('Sign out', 'user.signOut')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
