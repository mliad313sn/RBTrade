import { KnowledgeCheck } from '@/components/novice/KnowledgeCheck';
import { serverClient } from '@/lib/api-server';
import { localisedTitle } from '@/lib/i18n/metadata';

/** Localised page title (IRTC R5-12). */
export function generateMetadata() {
  return localisedTitle('meta.check');
}

export default async function Page() {
  const data = await (await serverClient()).knowledgeCheck().catch(() => null);
  return <KnowledgeCheck initial={data} />;
}
