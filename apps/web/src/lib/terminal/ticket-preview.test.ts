import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderResultText } from './format';
import { inputKey, previewSummary, requestKey, SettledAnnouncer } from './ticket-preview';

describe('ticket preview announcements (IRTC R5-05)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('announces once per settled edit and never on tick-driven re-previews', () => {
    const said: string[] = [];
    const a = new SettledAnnouncer((t) => said.push(t), 1000);
    // The user edits the quantity: one key; previews keep arriving twice a second as the stop moves.
    for (let i = 0; i < 20; i++) {
      a.offer('qty=1', `Loss ${100 + i}`);
      vi.advanceTimersByTime(500);
    }
    expect(said).toEqual(['Loss 101']);
    // A new edit is announced once, with the latest figures, 1 s after it settles.
    a.offer('qty=2', 'Loss 200');
    vi.advanceTimersByTime(400);
    a.offer('qty=3', 'Loss 300');
    vi.advanceTimersByTime(999);
    expect(said).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(['Loss 101', 'Loss 300']);
    for (let i = 0; i < 10; i++) {
      a.offer('qty=3', `Loss ${300 + i}`);
      vi.advanceTimersByTime(500);
    }
    expect(said).toHaveLength(2);
  });

  it('stays silent without a key or text, and clear() drops a pending message', () => {
    const said: string[] = [];
    const a = new SettledAnnouncer((t) => said.push(t));
    a.offer(null, 'x');
    a.offer('k', '');
    a.offer('k2', 'pending');
    a.clear();
    vi.advanceTimersByTime(5000);
    expect(said).toEqual([]);
  });

  it('keys and summary', () => {
    expect(requestKey(null)).toBeNull();
    expect(requestKey({ qty: '1' })).toBe('{"qty":"1"}');
    expect(inputKey({ a: 1 })).toBe('{"a":1}');
    expect(previewSummary(null, 0)).toBe('');
    expect(
      previewSummary(
        {
          currency: 'USD',
          margin: { required: '32523' },
          fees: { total: '3.2' },
          lossIfStopHit: { total: '150' },
        },
        0,
      ),
    ).toBe('Loss if stop hit 150.00 USD, margin 32,523.00 USD, fees 3.20 USD.');
    expect(
      previewSummary(
        { currency: 'USD', margin: { required: '1' }, fees: { total: '0' }, lossIfStopHit: null },
        2,
      ),
    ).toBe('No stop: loss not capped, margin 1.00 USD, fees 0.00 USD. 2 risk checks failed.');
  });
});

describe('order result text (IRTC R5-07)', () => {
  it('shows the average fill price at the instrument precision, not 40 decimals', () => {
    const o = {
      status: 'filled',
      side: 'buy',
      qty: '900000',
      symbol: 'EURUSD',
      avgFillPrice: '1.083490166666666666666666666666666666667',
    };
    expect(orderResultText(o, { qty: 0, price: 5 })).toBe(
      'Order filled: buy 900,000 EURUSD at 1.08349.',
    );
    expect(
      orderResultText(
        { ...o, status: 'partially_filled', avgFillPrice: '65214.349999' },
        { qty: 0, price: 1 },
      ),
    ).toBe('Order partially filled: buy 900,000 EURUSD at 65,214.3.');
    expect(
      orderResultText({ ...o, status: 'accepted', avgFillPrice: null }, { qty: 0, price: 5 }),
    ).toBe('Order accepted: buy 900,000 EURUSD.');
  });
});
