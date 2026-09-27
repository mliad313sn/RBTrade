'use client';

import type { HoldLabels } from '@kora/ui';

import { useI18n } from './react';

/**
 * Localised strings for the hold-to-confirm primitive (IRTC R5-04). Inside the Novice view the
 * instruction, status and confirm step follow the viewer's language; Pro screens keep the English
 * defaults of the primitive.
 */
export function useHoldLabels(): { labels?: Partial<HoldLabels>; locale: string } {
  const { t, novice, locale } = useI18n();
  if (!novice) return { locale: 'en' };
  return {
    locale,
    labels: {
      instruction: (s) => t('hold.instruction', { s }),
      holding: t('hold.holding'),
      confirmed: t('hold.confirmed'),
      confirmTitle: t('hold.confirmTitle'),
      confirmBody: t('hold.confirmBody'),
      confirm: t('hold.confirm'),
      cancel: t('hold.cancel'),
    },
  };
}
