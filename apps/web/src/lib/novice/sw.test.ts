import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

/**
 * Drives public/sw.js in a VM with fake `caches` and `fetch` (goal 08 §8): install precaches the
 * offline shell, an offline navigation gets it, /api is never answered from the cache.
 */
const SW = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'public/sw.js'),
  'utf8',
);
const ORIGIN = 'https://kora.test';

type Handler = (e: {
  request?: unknown;
  respondWith?: (p: Promise<Response>) => void;
  waitUntil?: (p: Promise<unknown>) => void;
}) => void;

function boot(online: { value: boolean }) {
  const store = new Map<string, Response>();
  const handlers = new Map<string, Handler>();
  const key = (r: string | Request) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
  const cache = {
    addAll: async (urls: string[]) => {
      for (const u of urls) store.set(key(u), await fakeFetch(u));
    },
    add: async (u: string) => void store.set(key(u), await fakeFetch(u)),
    match: async (r: string | Request) => store.get(key(r))?.clone(),
    put: async (r: Request, res: Response) => void store.set(key(r), res),
  };
  async function fakeFetch(r: string | Request): Promise<Response> {
    if (!online.value) throw new TypeError('Failed to fetch');
    const path = key(r);
    if (path === '/offline')
      return new Response(
        '<main data-testid="offline-shell">Prices paused</main><link href="/_next/static/css/a.css">',
        { status: 200 },
      );
    return new Response(`live ${path}`, { status: 200 });
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, h: Handler) => handlers.set(t, h),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  vm.runInNewContext(SW, {
    self,
    caches: {
      open: async () => cache,
      keys: async () => ['old-cache'],
      delete: async () => true,
      match: cache.match,
    },
    fetch: fakeFetch,
    URL,
    Response,
    Set,
    Promise,
  });
  return { handlers, store };
}

async function dispatch(
  h: Handler,
  request: { url: string; method: string; mode: string },
): Promise<Response | undefined> {
  let out: Promise<Response> | undefined;
  h({ request, respondWith: (p) => (out = p) });
  return out ? await out : undefined;
}

describe('service worker offline shell', () => {
  it('precaches /offline and its assets, serves it for an offline navigation, never caches /api', async () => {
    const online = { value: true };
    const { handlers, store } = boot(online);
    expect([...handlers.keys()].sort()).toEqual(['activate', 'fetch', 'install']);
    let installed: Promise<unknown> | undefined;
    handlers.get('install')!({ waitUntil: (p) => (installed = p) });
    await installed;
    expect([...store.keys()]).toEqual(
      expect.arrayContaining([
        '/offline',
        '/manifest.webmanifest',
        '/icons/icon-192.png',
        '/_next/static/css/a.css',
      ]),
    );

    const fetchH = handlers.get('fetch')!;
    // Online navigation: the network answers.
    expect(
      await (await dispatch(fetchH, {
        url: `${ORIGIN}/home`,
        method: 'GET',
        mode: 'navigate',
      }))!.text(),
    ).toBe('live /home');
    // Offline navigation: the cached "Prices paused" shell.
    online.value = false;
    const res = await dispatch(fetchH, {
      url: `${ORIGIN}/practice`,
      method: 'GET',
      mode: 'navigate',
    });
    expect(await res!.text()).toContain('Prices paused');
    // API calls and writes are never handled by the service worker (no stale prices, no queued orders).
    expect(
      await dispatch(fetchH, {
        url: `${ORIGIN}/api/quotes?symbols=EURUSD`,
        method: 'GET',
        mode: 'cors',
      }),
    ).toBeUndefined();
    expect(
      await dispatch(fetchH, { url: `${ORIGIN}/api/orders`, method: 'POST', mode: 'cors' }),
    ).toBeUndefined();
    expect(
      await dispatch(fetchH, {
        url: 'https://elsewhere.test/x.js',
        method: 'GET',
        mode: 'no-cors',
      }),
    ).toBeUndefined();
  });
});
