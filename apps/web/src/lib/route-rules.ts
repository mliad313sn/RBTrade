import { hasAnyRole, ROBOT_BUILDER_ROLES, type Role } from '@kora/domain';

/** Routes reachable without a session (goal 08 adds the PWA offline shell and assets). */
export const PUBLIC_PATHS = ['/login', '/signup', '/forbidden', '/offline'];
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
  { pattern: /^\/admin(\/.*)?$/, roles: ['admin'], feature: 'Administration' },
];

export type RouteDecision = { allow: true } | { allow: false; feature: string; requiredRoles: readonly Role[] };

export function checkRoute(pathname: string, roles: readonly Role[]): RouteDecision {
  const rule = ROUTE_RULES.find((r) => r.pattern.test(pathname));
  if (!rule || hasAnyRole(roles, rule.roles)) return { allow: true };
  return { allow: false, feature: rule.feature, requiredRoles: rule.roles };
}
