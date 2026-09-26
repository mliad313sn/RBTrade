import { redirect } from 'next/navigation';

import { requireMe } from '@/lib/api-server';
import { landingPath } from '@/lib/modes';

export const dynamic = 'force-dynamic';

export default async function Index() {
  const me = await requireMe();
  redirect(landingPath(me.roles, me.preferences.viewMode));
}
