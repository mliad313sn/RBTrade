import type { ReactNode } from 'react';

import { AppShell } from '@/components/shell/AppShell';
import { requireMe, serverClient } from '@/lib/api-server';
import { getLocale } from '@/lib/i18n/server';
import { parseExplainMode } from '@/lib/novice/explain-flag';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await requireMe();
  const locale = await getLocale();
  // Goal 08: the Novice banner shows the regulatory risk warning from the disclosures registry
  // (Compliance-set figure, "[XX]" until the Sponsor supplies it), in the viewer's language.
  const disclosure =
    me.preferences.viewMode === 'novice'
      ? await (
          await serverClient()
        )
          .disclosure('risk-warning', locale)
          .then((r) => r.document)
          .catch(() => null)
      : null;
  return (
    <AppShell
      me={me}
      locale={locale}
      disclosure={disclosure}
      explainMode={parseExplainMode(process.env.KORA_EXPLAIN_THIS)}
    >
      {children}
    </AppShell>
  );
}
