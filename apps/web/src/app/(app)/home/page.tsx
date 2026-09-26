import { hasAnyRole, type Role } from '@kora/domain';
import { redirect } from 'next/navigation';

import { NoviceHome } from '@/components/novice/NoviceHome';
import { requireMe, serverClient } from '@/lib/api-server';
import { DEFAULT_SYMBOL } from '@/lib/modes';

export const metadata = { title: 'Home' };

const PRO_ROLES: readonly Role[] = ['trader', 'quant', 'risk_officer', 'admin'];

/**
 * Novice home (goal 08). Data is fetched on the server so the balance is in the first paint
 * (mobile LCP). Novice-only users who have not finished onboarding go there first.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ symbol?: string }> }) {
  const symbol = ((await searchParams).symbol ?? DEFAULT_SYMBOL).toUpperCase();
  const [me, client] = await Promise.all([requireMe(), serverClient()]);
  const [profile, summary, assets, autoInvest] = await Promise.all([
    client.noviceProfile().catch(() => null),
    client.noviceSummary().catch(() => null),
    client.noviceAssets().catch(() => null),
    client.autoInvest().catch(() => null),
  ]);
  if (profile && !profile.onboarding.completed && !hasAnyRole(me.roles, PRO_ROLES)) redirect('/onboarding');
  return <NoviceHome initial={{ profile, summary, assets, autoInvest }} symbol={symbol} />;
}
