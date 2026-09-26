import 'server-only';

import { cookies, headers } from 'next/headers';

import { LOCALE_COOKIE, makeT, pickLocale, type Locale, type T } from './index';

/** The viewer's language for server components (cookie, then Accept-Language). */
export async function getLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return pickLocale(c.get(LOCALE_COOKIE)?.value, h.get('accept-language'));
}

export async function getT(): Promise<{ locale: Locale; t: T }> {
  const locale = await getLocale();
  return { locale, t: makeT(locale) };
}
