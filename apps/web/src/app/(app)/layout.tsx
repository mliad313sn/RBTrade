import type { ReactNode } from 'react';

import { AppShell } from '@/components/shell/AppShell';
import { requireMe } from '@/lib/api-server';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await requireMe();
  return <AppShell me={me}>{children}</AppShell>;
}
