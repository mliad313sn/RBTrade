import { AUDIT_READ_ROLES, hasAnyRole, ROBOT_BUILDER_ROLES, type Role } from '@kora/domain';

/** Routes reachable without a session (goal 07B: public reliability page; goal 08: PWA offline shell and assets). */
export const PUBLIC_PATHS = ['/login', '/signup', '/forbidden', '/reliability', '/offline'];
export const PWA_PUBLIC_FILES = ['/sw.js', '/manifest.webmanifest'];

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/') ||
    pathname === '/favicon.ico' ||
    pathname === '/icon.svg' ||
    PWA_PUBLIC_FILES.includes(pathname) ||
    pathname.startsWith('/icons/')
  );
}

interface Rule {
  pattern: RegExp;
  roles: readonly Role[];
  feature: string;
}

/**
 * Web route guards (UX only — the API enforces the same rules). Order matters: first match wins.
 */
export const ROUTE_RULES: Rule[] = [
  { pattern: /^\/robots(\/.*)?$/, roles: ROBOT_BUILDER_ROLES, feature: 'Robot builder' },
  // Goal 09: 2nd line console and 3rd line internal audit view.
  { pattern: /^\/risk(\/.*)?$/, roles: ['risk_officer', 'admin'], feature: 'Risk console' },
  { pattern: /^\/internal-audit(\/.*)?$/, roles: AUDIT_READ_ROLES, feature: 'Internal audit' },
  { pattern: /^\/admin(\/.*)?$/, roles: ['admin'], feature: 'Administration' },
];

export type RouteDecision = { allow: true } | { allow: false; feature: string; requiredRoles: readonly Role[] };

export function checkRoute(pathname: string, roles: readonly Role[]): RouteDecision {
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- linear pattern (no nested quantifiers), reviewed goal 10
  const rule = ROUTE_RULES.find((r) => r.pattern.test(pathname));
  if (!rule || hasAnyRole(roles, rule.roles)) return { allow: true };
  return { allow: false, feature: rule.feature, requiredRoles: rule.roles };
}
