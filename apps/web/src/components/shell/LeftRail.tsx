'use client';

import { hasAnyRole, type Role } from '@kora/domain';
import { Bot, CandlestickChart, ClipboardCheck, PieChart, Radar, Settings, ShieldAlert, Sigma } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useShell } from './ShellContext';

const ITEMS = [
  { href: '/terminal', label: 'Terminal', Icon: CandlestickChart },
  { href: '/radar', label: 'Market Radar', Icon: Radar },
  { href: '/simulator', label: 'Simulator', Icon: Sigma },
  { href: '/robots', label: 'Robots', Icon: Bot, needs: 'robotBuilder' as const },
  { href: '/portfolio', label: 'Portfolio', Icon: PieChart },
];

/** Goal 09: shown only to the roles that can use them (the API enforces the same rules). */
const GOVERNANCE_ITEMS: Array<{ href: string; label: string; Icon: typeof Bot; roles: readonly Role[] }> = [
  { href: '/risk', label: 'Risk console', Icon: ShieldAlert, roles: ['risk_officer', 'admin'] },
  { href: '/internal-audit', label: 'Internal audit', Icon: ClipboardCheck, roles: ['auditor', 'risk_officer', 'admin'] },
];

export function LeftRail() {
  const pathname = usePathname();
  const { me } = useShell();
  const link = (href: string, label: string, Icon: typeof Bot, locked = false) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <li key={href}>
        <Link
          href={href}
          // A locked module answers 403; prefetching it only leaves a dangling request (IRTC R5-25:
          // governance users without the trader role now get this rail).
          prefetch={locked ? false : undefined}
          aria-label={locked ? `${label} (not on your account)` : label}
          title={label}
          aria-current={active ? 'page' : undefined}
          className={`flex items-center justify-center w-9 h-9 rounded ${active ? 'bg-raised text-accent' : 'text-muted hover:text-text'} ${locked ? 'opacity-60' : ''}`}
        >
          <Icon size={18} aria-hidden="true" />
        </Link>
      </li>
    );
  };
  return (
    <nav aria-label="Modules" className="flex flex-col items-center justify-between w-12 py-2 border-r border-border bg-bg">
      <ul className="flex flex-col gap-1 list-none m-0 p-0">
        {ITEMS.map((i) => link(i.href, i.label, i.Icon, i.needs ? !me.capabilities[i.needs] : false))}
        {GOVERNANCE_ITEMS.filter((i) => hasAnyRole(me.roles, i.roles)).map((i) => link(i.href, i.label, i.Icon))}
      </ul>
      <ul className="list-none m-0 p-0">{link('/settings', 'Settings', Settings)}</ul>
    </nav>
  );
}
