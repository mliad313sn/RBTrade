/*
 * Kora service worker (goal 08 §8): an offline shell only.
 * - Navigations go to the network; when it fails, the cached /offline page ("Prices paused") shows.
 * - Build assets (/_next/static, hashed) and icons are cached on first use.
 * - /api is never cached: prices, balances and orders always come from the server.
 * - There is deliberately no `push` or `notificationclick` handler: Kora sends no notifications
 *   that encourage trading (security and limit alerts come later through a separate, reviewed path).
 */
const VERSION = 'kora-shell-v1';
const OFFLINE_URL = '/offline';
const PRECACHE = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(PRECACHE);
      // Also keep the offline page's own stylesheets and scripts, so it renders without a network.
      const res = await cache.match(OFFLINE_URL);
      if (res) {
        const html = await res.text();
        const assets = [...html.matchAll(/(?:href|src)="(\/_next\/static\/[^"]+)"/g)].map(
          (m) => m[1],
        );
        await Promise.all([...new Set(assets)].map((a) => cache.add(a).catch(() => undefined)));
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cached

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) ?? Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) (await caches.open(VERSION)).put(req, res.clone()).catch(() => undefined);
        return res;
      })(),
    );
  }
});
