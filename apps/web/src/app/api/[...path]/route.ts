import type { NextRequest } from 'next/server';

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
  // Forward only the nearest hop's address: a client-supplied X-Forwarded-For chain must not reach
  // the API (rate limits and audit IPs key on it). Production puts a trusted edge proxy in front.
  const hop = (req.headers.get('x-forwarded-for') ?? '').split(',').pop()?.trim();
  headers.set('x-forwarded-for', hop || '127.0.0.1');
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
