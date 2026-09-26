import type { ViewMode } from '@kora/domain';

export interface NavItem {
  href: string;
  label: string;
}

export const PRO_NAV: NavItem[] = [
  { href: '/terminal', label: 'Terminal' },
  { href: '/radar', label: 'Market Radar' },
  { href: '/simulator', label: 'Simulator' },
  { href: '/robots', label: 'Robots' },
  { href: '/portfolio', label: 'Portfolio' },
];

export const NOVICE_NAV: NavItem[] = [
  { href: '/home', label: 'Home' },
  { href: '/practice', label: 'Practice' },
  { href: '/auto-invest', label: 'Auto-invest' },
  { href: '/learn', label: 'Learn' },
];

const TO_NOVICE: Record<string, string> = {
  '/terminal': '/home',
  '/radar': '/home',
  '/simulator': '/practice',
  '/robots': '/auto-invest',
  '/portfolio': '/home',
  '/settings': '/settings',
  '/audit': '/audit',
};
const TO_PRO: Record<string, string> = {
  '/home': '/terminal',
  '/practice': '/simulator',
  '/auto-invest': '/terminal',
  '/learn': '/terminal',
  '/settings': '/settings',
  '/audit': '/audit',
};

export const HOME: Record<ViewMode, string> = { pro: '/terminal', novice: '/home' };

/** The equivalent screen in the other mode. Keeps the instrument (?symbol=) and flags the switch. */
export function counterpartPath(pathname: string, target: ViewMode, search = ''): string {
  const top = `/${pathname.split('/')[1] ?? ''}`;
  const map = target === 'novice' ? TO_NOVICE : TO_PRO;
  const dest = map[top] ?? HOME[target];
  const params = new URLSearchParams(search);
  const symbol = params.get('symbol');
  const out = new URLSearchParams();
  if (symbol) out.set('symbol', symbol);
  out.set('switched', target);
  return `${dest}?${out.toString()}`;
}

export function isNoviceRoute(pathname: string): boolean {
  return NOVICE_NAV.some((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
}

export function isProRoute(pathname: string): boolean {
  return PRO_NAV.some((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
}

export const WHAT_CHANGED: Record<ViewMode, string> = {
  novice:
    'Simple view: same account and instrument. Advanced order types, market depth and the robot builder are hidden; every trade shows the most you could lose first.',
  pro: 'Pro view: same account and instrument. Full order types, depth and robots are available. Paper money only.',
};

export const DEFAULT_SYMBOL = 'EURUSD';
