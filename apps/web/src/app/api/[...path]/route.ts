import type { NextRequest } from 'next/server';

import { clientAddress, peerStampActive, trustedProxyHops } from '@/lib/forwarded';

/**
 * Same-origin proxy to the API (read at runtime from API_INTERNAL_URL), so the session cookie stays
 * HttpOnly + SameSite=Strict and the browser never talks to the API origin directly.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FORWARD_REQUEST = ['content-type', 'cookie', 'authorization', 'x-kora-csrf', 'accept', 'user-agent'];
const FORWARD_RESPONSE = [
  'content-type',
  'set-cookie',
  'cache-control',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
  'location',
  // Goal 09: evidence and audit exports (file name, SHA-256, row count, sampling seed, paging).
  'content-disposition',
  'x-kora-evidence-sha256',
  'x-kora-evidence-rows',
  'x-kora-sample-seed',
  'x-kora-next-before-id',
];

// Staging/production must run with the peer-address preload (Dockerfile) or a configured ingress hop
// count; otherwise every user would share one rate-limit bucket (IRTC R1-05).
const STRICT_ENV = ['staging', 'production'].includes(process.env.KORA_ENV ?? '');
let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn('[kora-web] peer-address.cjs is not preloaded and KORA_TRUSTED_PROXY_HOPS=0: every client is reported as 127.0.0.1 (IRTC R1-05).');
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
  const target = new URL(`${base.replace(/\/$/, '')}/${path.map(encodeURIComponent).join('/')}`);
  target.search = req.nextUrl.search;
  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // B-015 (goal 10) + IRTC R1-05: a client-supplied X-Forwarded-For never reaches the API (rate
  // limits and audit IPs key on it). Behind a trusted ingress (KORA_TRUSTED_PROXY_HOPS >= 1) the
  // address it appended is used; with none, the real TCP peer stamped by peer-address.cjs.
  const hops = trustedProxyHops();
  if (hops === 0 && !peerStampActive()) {
    if (STRICT_ENV) {
      return Response.json(
        { statusCode: 503, error: 'proxy_misconfigured', message: 'The KORA web proxy cannot attribute client addresses (see the deployment checklist).' },
        { status: 503 },
      );
    }
    warnOnce();
  }
  headers.set('x-forwarded-for', clientAddress(req.headers, hops));
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json({ statusCode: 502, error: 'api_unreachable', message: 'The KORA API is not reachable.' }, { status: 502 });
  }
  const out = new Headers();
  for (const h of FORWARD_RESPONSE) {
    if (h === 'set-cookie') {
      for (const c of upstream.headers.getSetCookie()) out.append('set-cookie', c);
    } else {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
  }
  if (target.pathname.endsWith('/auth/oidc/callback')) {
    out.set('content-security-policy', "default-src 'none'");
  }
  // Goal 07: Server-Sent Events (copilot streaming) pass through unbuffered.
  if ((upstream.headers.get('content-type') ?? '').startsWith('text/event-stream') && upstream.body) {
    out.set('cache-control', 'no-cache, no-transform');
    out.set('x-accel-buffering', 'no');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
