import { AutoInvest } from '@/components/novice/AutoInvest';
import { serverClient } from '@/lib/api-server';
import { localisedTitle } from '@/lib/i18n/metadata';

/** Localised page title (IRTC R5-12). */
export function generateMetadata() {
  return localisedTitle('nav.autoInvest');
}

export default async function Page() {
  const list = await (await serverClient()).autoInvest().catch(() => null);
  return <AutoInvest initial={list} />;
}
