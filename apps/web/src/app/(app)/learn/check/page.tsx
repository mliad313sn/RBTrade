import { KnowledgeCheck } from '@/components/novice/KnowledgeCheck';
import { serverClient } from '@/lib/api-server';

export const metadata = { title: '5-question check' };

export default async function Page() {
  const data = await (await serverClient()).knowledgeCheck().catch(() => null);
  return <KnowledgeCheck initial={data} />;
}
