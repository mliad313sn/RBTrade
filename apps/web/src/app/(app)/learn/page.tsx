import { Learn } from '@/components/novice/Learn';
import { serverClient } from '@/lib/api-server';
import { getLocale } from '@/lib/i18n/server';

export const metadata = { title: 'Learn' };

export default async function Page() {
  const [client, locale] = await Promise.all([serverClient(), getLocale()]);
  const disclosure = await client
    .disclosure('risk-warning', locale)
    .then((r) => r.document)
    .catch(() => null);
  return <Learn disclosure={disclosure} />;
}
