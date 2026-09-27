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

/** Goal 09: an internal auditor (3rd line, no operating role) lands on the internal audit view. */
export function landingPath(roles: readonly string[], mode: ViewMode): string {
  if (
    roles.includes('auditor') &&
    !roles.some((r) => ['trader', 'quant', 'risk_officer', 'admin'].includes(r))
  )
    return '/internal-audit';
  return HOME[mode];
}

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

/** Second- and third-line screens: always in the Pro shell (IRTC R5-25). */
export const GOVERNANCE_ROUTES = ['/risk', '/internal-audit', '/admin'];

export function isGovernanceRoute(pathname: string): boolean {
  return GOVERNANCE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

export const WHAT_CHANGED: Record<ViewMode, string> = {
  novice:
    'Simple view: same account and instrument. Advanced order types, market depth and the robot builder are hidden; every trade shows the most you could lose first.',
  pro: 'Pro view: same account and instrument. Full order types, depth and robots are available. Paper money only.',
};

/**
 * IRTC R5-10: the Pro view for an account that has not passed the appropriateness assessment. The
 * screens are the Pro ones, but the server keeps the simple-view rules; say so instead of promising
 * "full order types, depth and robots".
 */
export const WHAT_CHANGED_PRO_NOVICE_ONLY =
  'Pro view: same account and instrument. Your account has not passed the Pro assessment yet, so the simple-view rules still apply on the server: every new trade needs a stop loss, and borrowing and robots stay off. Paper money only.';

export const DEFAULT_SYMBOL = 'EURUSD';
