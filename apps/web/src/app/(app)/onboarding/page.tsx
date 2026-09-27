import { redirect } from 'next/navigation';

import { Onboarding } from '@/components/novice/Onboarding';
import { serverClient } from '@/lib/api-server';
import { getLocale } from '@/lib/i18n/server';
import { localisedTitle } from '@/lib/i18n/metadata';

/** Localised page title (IRTC R5-12). */
export function generateMetadata() {
  return localisedTitle('meta.welcome');
}

export default async function OnboardingPage() {
  const [client, locale] = await Promise.all([serverClient(), getLocale()]);
  const [profile, summary, disclosure] = await Promise.all([
    client.noviceProfile(),
    client.noviceSummary().catch(() => null),
    client
      .disclosure('risk-warning', locale)
      .then((r) => r.document)
      .catch(() => null),
  ]);
  if (profile.onboarding.completed) redirect('/home');
  return <Onboarding profile={profile} disclosure={disclosure} startingBalance={summary?.startingBalance ?? null} />;
}
