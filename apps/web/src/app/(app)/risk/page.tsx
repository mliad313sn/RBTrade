import { RiskConsole } from '@/components/governance/RiskConsole';
import { apiWsPort } from '@/lib/market-ws';

export const metadata = { title: 'Risk console' };

export default function Page() {
  return <RiskConsole wsPort={apiWsPort()} />;
}
