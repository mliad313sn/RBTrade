import { NextResponse, type NextRequest } from 'next/server';

import { apiWsPort } from './lib/market-ws';
import { checkRoute, isPublicPath } from './lib/route-rules';
import { verifySession } from './lib/session';

function csp(nonce: string, dev: boolean, wsHost: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The market data WebSocket lives on the api port of the same host (goal 02).
    `connect-src 'self' ws://${wsHost} wss://${wsHost}${dev ? ' ws: wss:' : ''}`,
    // Goal 08 PWA: the offline-shell service worker and the web app manifest (same origin only).
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * 1. CSP with a per-request nonce.
 * 2. Session check (JWKS-verified JWT) → /login when missing/invalid.
 * 3. Role route guards → rewrite to /forbidden with HTTP 403 (friendly page). The API re-checks.
 */
export async function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  // The browser connects to the api on the page's own hostname (so the session cookie is sent).
  const rawHost = (req.headers.get('host') ?? req.nextUrl.host).replace(/:\d+$/, '');
  const pageHost = /^[a-z0-9.-]{1,253}$/i.test(rawHost) ? rawHost : 'localhost';
  const policy = csp(nonce, process.env.NODE_ENV !== 'production', `${pageHost}:${apiWsPort()}`);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  const { pathname, search } = req.nextUrl;

  const finish = (res: NextResponse) => {
    res.headers.set('Content-Security-Policy', policy);
    return res;
  };

  if (isPublicPath(pathname)) {
    return finish(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const session = await verifySession(req.cookies.get('kora_at')?.value);
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return finish(NextResponse.redirect(url));
  }

  const decision = checkRoute(pathname, session.roles);
  if (!decision.allow) {
    // Render the friendly page with a real HTTP 403 (a rewrite cannot change the status code).
    const url = req.nextUrl.clone();
    url.pathname = '/forbidden';
    url.search = `?feature=${encodeURIComponent(decision.feature)}&from=${encodeURIComponent(pathname)}`;
    const page = await fetch(url, { headers: { accept: 'text/html' }, cache: 'no-store' });
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const pageCsp = page.headers.get('content-security-policy');
    if (pageCsp) headers.set('content-security-policy', pageCsp);
    return new NextResponse(page.body, { status: 403, headers });
  }

  return finish(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
