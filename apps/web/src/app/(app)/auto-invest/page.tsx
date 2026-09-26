import { AutoInvest } from '@/components/novice/AutoInvest';
import { serverClient } from '@/lib/api-server';

export const metadata = { title: 'Auto-invest' };

export default async function Page() {
  const list = await (await serverClient()).autoInvest().catch(() => null);
  return <AutoInvest initial={list} />;
}
