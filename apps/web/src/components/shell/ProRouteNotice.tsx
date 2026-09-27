'use client';

import { isNoviceOnly } from '@kora/domain';
import { Button, Panel, useToast } from '@kora/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { api } from '@/lib/api-browser';
import { useI18n } from '@/lib/i18n/react';

import { useShell } from './ShellContext';

/**
 * IRTC R5-10: a Pro-only screen opened while the account is in the simple view. The Pro panels used to
 * render into a zero-height novice layout (blank for sighted users, readable by screen readers). Now
 * the screen explains itself and offers the switch; a novice-only account is also told that the
 * simple-view rules stay on until it passes the appropriateness assessment (B-018).
 */
export function ProRouteNotice() {
  const { me, setMe } = useShell();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const noviceOnly = isNoviceOnly(me.roles);
  const switchToPro = () =>
    start(async () => {
      try {
        const r = await api.updatePreferences({ viewMode: 'pro' });
        setMe({ ...me, preferences: r.preferences, capabilities: r.capabilities });
        router.refresh();
      } catch {
        toast.push(t('mode.error'), 'critical');
      }
    });
  return (
    <div className="max-w-xl" data-testid="pro-route-in-simple-view">
      <Panel>
        <h1 className="k-panel__title m-0">{t('mode.proRoute.title')}</h1>
        <p className="mt-2 mb-4">
          {noviceOnly ? t('mode.proRoute.bodyNovice') : t('mode.proRoute.bodyTrader')}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={switchToPro} disabled={pending}>
            {t('mode.proRoute.switch')}
          </Button>
          {noviceOnly ? (
            <Link href="/appropriateness?from=pro" className="k-btn no-underline">
              {t('mode.proRoute.assess')}
            </Link>
          ) : null}
          <Link href="/home" className="k-btn no-underline">
            {t('mode.proRoute.home')}
          </Link>
        </div>
      </Panel>
    </div>
  );
}
