import type { MetadataRoute } from 'next';

/** Installable PWA (goal 08 §8): opens on the Novice home, standalone, light novice palette. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/home',
    name: 'Kora: practice trading',
    short_name: 'Kora',
    description:
      'Plain-language trading with practice money. Every trade shows the most you could lose first.',
    start_url: '/home',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#F7F5F0',
    theme_color: '#1C2430',
    lang: 'en',
    categories: ['finance', 'education'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
