'use client';

import { Banner } from '@kora/ui';
import { useEffect, useSyncExternalStore } from 'react';

import { useI18n } from '@/lib/i18n/react';

/**
 * Mobile PWA pieces (goal 08 §8): registers the offline-shell service worker (production builds
 * only) and shows a calm "Prices paused" state while the device is offline. No push subscription
 * is ever requested: the service worker has no push handler (no nudges to trade).
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}

const PAUSED_EVENT = 'kora:prices-paused';
let forced = false;

/** Other parts of the view can report that prices stopped arriving (e.g. a failed fetch). */
export function reportPricesPaused(paused: boolean): void {
  forced = paused;
  window.dispatchEvent(new Event(PAUSED_EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  window.addEventListener(PAUSED_EVENT, cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
    window.removeEventListener(PAUSED_EVENT, cb);
  };
}

export function usePricesPaused(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !navigator.onLine || forced,
    () => false,
  );
}

export function PricesPausedBanner({ className }: { className?: string }) {
  const paused = usePricesPaused();
  const { t } = useI18n();
  if (!paused) return null;
  return (
    <div className={className} role="status" data-testid="prices-paused">
      <Banner tone="info" title={t('shell.paused.title')}>
        {t('shell.paused.body')}
      </Banner>
    </div>
  );
}
