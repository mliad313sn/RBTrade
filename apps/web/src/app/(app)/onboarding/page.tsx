import { redirect } from 'next/navigation';

import { Onboarding } from '@/components/novice/Onboarding';
import { serverClient } from '@/lib/api-server';
import { getLocale } from '@/lib/i18n/server';

export const metadata = { title: 'Welcome' };

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
