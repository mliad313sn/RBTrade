import { getT } from '@/lib/i18n/server';

export const metadata = { title: 'Offline' };

/**
 * Offline shell (goal 08 §8), cached by the service worker. Self-contained styles so it renders
 * without the network: a calm "Prices paused" state and nothing that looks like a live price.
 */
export default async function OfflinePage() {
  const { t } = await getT();
  return (
    <div
      data-theme="novice-light"
      style={{
        minHeight: '100vh',
        background: '#F7F5F0',
        color: '#1C2430',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <main
        data-testid="offline-shell"
        style={{
          maxWidth: 420,
          background: '#FFFFFF',
          border: '1px solid #E2DDD2',
          borderRadius: 16,
          padding: 24,
        }}
      >
        <p style={{ margin: 0, fontSize: 24 }} aria-hidden="true">
          ↗ Kora
        </p>
        <h1 style={{ fontSize: 28, margin: '16px 0 8px' }} data-testid="prices-paused-title">
          {t('offline.title')}
        </h1>
        <p style={{ margin: 0, fontSize: 17, lineHeight: 1.5 }}>{t('offline.body')}</p>
        <a
          href="/home"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 44,
            marginTop: 20,
            padding: '0 20px',
            borderRadius: 999,
            background: '#1C2430',
            color: '#FFFFFF',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          {t('offline.retry')}
        </a>
      </main>
    </div>
  );
}
