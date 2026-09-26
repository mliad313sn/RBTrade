import { redirect } from 'next/navigation';

import { requireMe } from '@/lib/api-server';
import { HOME } from '@/lib/modes';

export const dynamic = 'force-dynamic';

export default async function Index() {
  const me = await requireMe();
  redirect(HOME[me.preferences.viewMode]);
}
