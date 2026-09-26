'use client';

import type { OrderType } from '@kora/domain';
import { Button, NumberInput, Select } from '@kora/ui';
import { useState } from 'react';

import { useShell } from './shell/ShellContext';

const LABEL: Record<OrderType, string> = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  stop_limit: 'Stop-limit',
  trailing: 'Trailing',
  bracket: 'Bracket',
  oco: 'OCO',
};

/**
 * Ticket skeleton for the shell: order types come from server capabilities (view mode aware).
 * Preview numbers (cost, fees, margin, loss-at-stop) arrive with the paper engine in goal 03.
 */
export function OrderTicketPreview({ symbol }: { symbol: string }) {
  const { me } = useShell();
  const types = me.capabilities.orderTypes;
  const [type, setType] = useState<OrderType>(types.includes('limit') ? 'limit' : types[0]!);
  const [qty, setQty] = useState('100000');
  const [price, setPrice] = useState('');
  return (
    <div className="flex flex-col gap-3" data-testid="order-ticket">
      <div className="grid grid-cols-2 gap-2">
        <Button variant="buy" disabled title="Paper engine arrives in goal 03">
          BUY ▲
        </Button>
        <Button variant="sell" disabled title="Paper engine arrives in goal 03">
          SELL ▼
        </Button>
      </div>
      <div role="radiogroup" aria-label="Order type" className="flex flex-wrap gap-1" data-testid="order-types">
        {types.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={type === t}
            onClick={() => setType(t)}
            className={`k-btn k-btn--sm ${type === t ? 'bg-raised! text-text!' : 'k-btn--ghost text-muted!'}`}
          >
            {LABEL[t]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberInput label="Quantity (units)" value={qty} onValueChange={setQty} precision={0} step="1000" min="0" />
        <NumberInput label="Limit price" value={price} onValueChange={setPrice} precision={5} step="0.00001" min="0" placeholder="—" disabled={type === 'market'} />
      </div>
      <Select label="Time in force" options={[{ value: 'gtc', label: 'GTC' }, { value: 'day', label: 'Day' }, { value: 'ioc', label: 'IOC' }]} defaultValue="gtc" />
      <dl className="grid grid-cols-2 gap-y-1 text-xs m-0 k-num">
        {['Notional', 'Est. fees + spread', 'Margin impact', 'Loss if stop hit'].map((k) => (
          <div key={k} className="contents">
            <dt className="text-muted font-ui">{k}</dt>
            <dd className="m-0 text-right">—</dd>
          </div>
        ))}
      </dl>
      <Button variant="primary" block disabled>
        Review {symbol} order (goal 03)
      </Button>
    </div>
  );
}
