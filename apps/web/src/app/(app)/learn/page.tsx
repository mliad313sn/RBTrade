import { Learn } from '@/components/novice/Learn';
import { serverClient } from '@/lib/api-server';
import { getLocale } from '@/lib/i18n/server';
import { localisedTitle } from '@/lib/i18n/metadata';

/** Localised page title (IRTC R5-12). */
export function generateMetadata() {
  return localisedTitle('nav.learn');
}

export default async function Page() {
  const [client, locale] = await Promise.all([serverClient(), getLocale()]);
  const disclosure = await client
    .disclosure('risk-warning', locale)
    .then((r) => r.document)
    .catch(() => null);
  return <Learn disclosure={disclosure} />;
}
