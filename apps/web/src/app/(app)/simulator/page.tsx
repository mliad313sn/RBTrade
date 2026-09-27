import { GainSimulator } from '@/components/sim/GainSimulator';
import { serverClient } from '@/lib/api-server';

export const metadata = { title: 'Gain simulator' };

export default async function Page() {
  // IRTC R4-18: the retail-loss figure comes from the disclosures registry (placeholder until published).
  const pct = await (
    await serverClient()
  )
    .disclosure('risk-warning', 'en')
    .then((r) => r.document.values.retailLossPct ?? null)
    .catch(() => null);
  return <GainSimulator retailLossPct={pct} />;
}
