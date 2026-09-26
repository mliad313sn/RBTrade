'use client';

import { Button, NumberInput, Panel } from '@kora/ui';
import { useState } from 'react';

const INSTRUMENTS = [
  { symbol: 'EURUSD', label: 'Euro vs Dollar' },
  { symbol: 'XAUUSD', label: 'Gold' },
  { symbol: 'AAPL', label: 'Apple shares' },
  { symbol: 'BTCUSD', label: 'Bitcoin' },
];

/** Novice "Make a trade": no order types, plain words, "most you could lose" before anything happens. */
export function NoviceTradeCard({ symbol }: { symbol: string }) {
  const [pick, setPick] = useState(INSTRUMENTS.some((i) => i.symbol === symbol) ? symbol : 'EURUSD');
  const [side, setSide] = useState<'buy' | 'sell' | null>(null);
  const [amount, setAmount] = useState('500');
  return (
    <Panel title="Make a trade" data-testid="novice-trade">
      <p className="mt-0 text-muted">Three steps. You&apos;ll see the most you can lose before anything happens.</p>
      <fieldset className="border-0 p-0 m-0 mb-4">
        <legend className="font-semibold mb-2">1 · What do you want to trade?</legend>
        <div className="flex flex-wrap gap-2">
          {INSTRUMENTS.map((i) => (
            <button
              key={i.symbol}
              type="button"
              aria-pressed={pick === i.symbol}
              onClick={() => setPick(i.symbol)}
              className={`k-btn ${pick === i.symbol ? 'k-btn--primary' : ''}`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="border-0 p-0 m-0 mb-4">
        <legend className="font-semibold mb-2">2 · What do you think will happen?</legend>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={side === 'buy'} onClick={() => setSide('buy')} className={`k-btn ${side === 'buy' ? 'bg-up-surface! text-up! border-up!' : ''}`}>
            ▲ It will go up (buy)
          </button>
          <button type="button" aria-pressed={side === 'sell'} onClick={() => setSide('sell')} className={`k-btn ${side === 'sell' ? 'bg-down-surface! text-down! border-down!' : ''}`}>
            ▼ It will go down (sell)
          </button>
        </div>
      </fieldset>
      <NumberInput label="3 · How much? (in dollars)" value={amount} onValueChange={setAmount} precision={2} min="0" step="10" />
      <div className="mt-4 p-4 rounded-lg bg-raised border border-border">
        <p className="m-0 font-semibold">Safety net: sell automatically if it moves against me</p>
        <p className="m-0 mt-2 text-muted text-sm">
          Most you could lose: shown here when the simple trade flow arrives (the practice engine and its preview are ready). Every trade has a safety net.
        </p>
      </div>
      <Button variant="primary" size="lg" block className="mt-4" disabled>
        Review my trade
      </Button>
    </Panel>
  );
}
