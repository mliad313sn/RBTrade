import { Panel } from '@kora/ui';

import { NoviceTradeCard } from '@/components/NoviceTradeCard';
import { DEFAULT_SYMBOL } from '@/lib/modes';

export const metadata = { title: 'Home' };

export default async function HomePage({ searchParams }: { searchParams: Promise<{ symbol?: string }> }) {
  const symbol = ((await searchParams).symbol ?? DEFAULT_SYMBOL).toUpperCase();
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr_0.9fr]">
      <h1 className="k-sr-only">Home</h1>
      <div className="flex flex-col gap-5">
        <Panel title="Your practice account">
          <p className="font-display text-5xl m-0" aria-label="Balance not available yet">—</p>
          <p className="text-muted">Your practice balance appears once the practice engine is connected.</p>
        </Panel>
        <Panel title="What you own">
          <p className="text-muted m-0">Nothing yet.</p>
        </Panel>
      </div>
      <NoviceTradeCard symbol={symbol} />
      <div className="flex flex-col gap-5">
        <Panel title="Your limits">
          <p className="m-0 text-muted">You set these. Loosening one takes 24 hours. Borrowed money (leverage): Off.</p>
        </Panel>
        <Panel title="Learn in 2 minutes">
          <p className="m-0">
            <strong>Spread</strong>: the small gap between the buy and sell price. It&apos;s a cost you pay on every trade.
          </p>
          <p className="mb-0">
            <strong>Stop (safety net)</strong>: an automatic sell that limits how much you can lose.
          </p>
        </Panel>
      </div>
    </div>
  );
}
