'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from '@/lib/api-browser';

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
  return (
    <div className="relative">
      <button
        type="button"
        className="k-btn k-btn--ghost rounded-full! w-9 h-9 p-0! bg-raised!"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${me.user.displayName}`}
        onClick={() => setOpen((o) => !o)}
        data-testid="user-menu"
      >
        {initials(me.user.displayName) || 'ME'}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 mt-2 z-40 k-panel p-2 min-w-56 shadow-xl">
          <p className="text-xs text-muted px-2 py-1 m-0">
            {me.user.email} · {me.roles.join(', ')}
            {me.mfa ? ' · 2FA on' : ''}
          </p>
          {!me.roles.includes('trader') ? (
            <Link role="menuitem" className="block px-2 py-2 rounded hover:bg-raised no-underline text-accent" href="/appropriateness" onClick={() => setOpen(false)} data-testid="unlock-pro">
              Unlock Pro trading
            </Link>
          ) : null}
          <Link role="menuitem" className="block px-2 py-2 rounded hover:bg-raised no-underline" href="/settings" onClick={() => setOpen(false)}>
            Settings
          </Link>
          <Link role="menuitem" className="block px-2 py-2 rounded hover:bg-raised no-underline" href="/audit" onClick={() => setOpen(false)}>
            Audit log
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
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
