'use client';

import { isNoviceOnly, type ViewMode } from '@kora/domain';
import { Banner, Button } from '@kora/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { useI18n } from '@/lib/i18n/react';
import { WHAT_CHANGED, WHAT_CHANGED_PRO_NOVICE_ONLY } from '@/lib/modes';

import { useShell } from './ShellContext';

/** One-line note after a Pro ⇄ Novice switch (goal 01 §4). */
export function WhatChangedNote({ className = 'px-3 pt-2' }: { className?: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const switched = params.get('switched') as ViewMode | null;
  const { t, novice } = useI18n();
  const { me } = useShell();
  if (switched !== 'pro' && switched !== 'novice') return null;
  const safeguards = switched === 'pro' && isNoviceOnly(me.roles);
  const dismiss = () => {
    const next = new URLSearchParams(params.toString());
    next.delete('switched');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };
  return (
    <div className={className} data-testid="what-changed">
      <Banner
        tone="info"
        title={novice ? t('shell.switched.title') : 'View switched.'}
        action={
          <Button size="sm" variant="ghost" onClick={dismiss}>
            {novice ? t('shell.switched.dismiss') : 'Dismiss'}
          </Button>
        }
      >
        {novice && switched === 'novice' ? (
          t('shell.switched.body')
        ) : safeguards ? (
          <span data-testid="pro-safeguards">
            {WHAT_CHANGED_PRO_NOVICE_ONLY}{' '}
            <Link href="/appropriateness?from=pro" className="underline">
              Take the assessment to unlock Pro trading.
            </Link>
          </span>
        ) : (
          WHAT_CHANGED[switched]
        )}
      </Banner>
    </div>
  );
}
