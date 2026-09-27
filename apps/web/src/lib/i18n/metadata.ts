import 'server-only';

import type { Metadata } from 'next';

import { requireMe } from '@/lib/api-server';

import { translate, type MessageKey } from './index';
import { getT } from './server';

/**
 * Localised `<title>` for Novice screens (IRTC R5-12): page titles used to be static English
 * `metadata`, so French screen-reader users heard "Home · KORA". Screens shared with Pro (settings,
 * the appropriateness check) follow the viewer's view: French only in the simple view.
 */
export async function localisedTitle(
  key: MessageKey,
  opts: { sharedWithPro?: boolean } = {},
): Promise<Metadata> {
  const { locale, t } = await getT();
  if (locale === 'en') return { title: t(key) };
  if (opts.sharedWithPro) {
    const me = await requireMe().catch(() => null);
    if (me?.preferences.viewMode !== 'novice') return { title: translate('en', key) };
  }
  return { title: t(key) };
}
