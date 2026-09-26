import { Banner, Panel, Tabs } from '@kora/ui';

import { OrderTicketPreview } from '@/components/OrderTicketPreview';
import { LiveWatchlist } from '@/components/terminal/LiveWatchlist';
import { apiWsPort } from '@/lib/market-ws';
import { DEFAULT_SYMBOL } from '@/lib/modes';

export const metadata = { title: 'Terminal' };

export default async function TerminalPage({ searchParams }: { searchParams: Promise<{ symbol?: string }> }) {
  const symbol = ((await searchParams).symbol ?? DEFAULT_SYMBOL).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return (
    <div className="grid gap-2 h-full grid-cols-1 lg:grid-cols-[240px_1fr_320px] lg:grid-rows-[1fr_220px]">
      <h1 className="k-sr-only">Pro terminal — {symbol}</h1>
      <Panel title="Watchlist · Majors" className="lg:row-span-1">
        <LiveWatchlist wsPort={apiWsPort()} />
      </Panel>
      <Panel title={`${symbol} · chart`}>
        <Banner tone="info" title="Simulated feed · not market data.">
          The chart, order book and calendar panels arrive with the Pro terminal (goal 04).
        </Banner>
      </Panel>
      <Panel title="Order ticket" className="lg:row-span-2">
        <OrderTicketPreview symbol={symbol} />
      </Panel>
      <Panel className="lg:col-span-2" aria-label="Blotter">
        <Tabs
          label="Blotter"
          items={['Positions', 'Orders', 'Fills', 'Alerts', 'Risk'].map((t) => ({
            value: t.toLowerCase(),
            label: t,
            content: <p className="text-muted text-sm px-2">No {t.toLowerCase()} yet. The paper engine arrives in goal 03.</p>,
          }))}
        />
      </Panel>
    </div>
  );
}
