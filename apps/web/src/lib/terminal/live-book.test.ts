import type { PositionDto } from '@kora/domain';
import type { AccountView } from '@kora/sdk';
import { describe, expect, it } from 'vitest';

import { accountStale, liveAccount, markPositions, newerAccount, type LiveQuote } from './live-book';

const pos = (over: Partial<PositionDto> = {}): PositionDto => ({
  accountId: 'a',
  symbol: 'BTCUSD',
  qty: '1',
  avgPrice: '65200',
  markPrice: '65214.3',
  quoteCcy: 'USD',
  unrealizedPnl: '14.30',
  realizedPnl: '0.00',
  notional: '65214.30',
  marginUsed: '32607.15',
  updatedAt: '2026-09-27T10:00:00Z',
  stale: false,
  ...over,
});

const acct = (over: Partial<AccountView> = {}): AccountView =>
  ({
    id: 'a',
    baseCurrency: 'USD',
    cash: '99934.08',
    equity: '99948.38',
    unrealizedPnl: '14.30',
    dayPnl: '-51.62',
    marginUsed: '32607.15',
    marginFree: '67341.23',
    marginUsedPct: '32.62',
    dailyLossLimit: '2000.00',
    dailyLossUsedPct: '2.58',
    openPositions: 1,
    asOf: '2026-09-27T10:00:00.000Z',
    ...over,
  }) as AccountView;

const q = (bid: string, ask: string, receivedAt = 1_000, stale = false): LiveQuote => ({ bid, ask, stale, receivedAt });

describe('live mark-to-market of the blotter and the account (IRTC R5-02)', () => {
  it('reprices a long at the bid and a short at the ask, with the engine multiplier and FX', () => {
    const quotes = new Map([
      ['BTCUSD', q('65274.3', '65280.3')],
      // EUR/JPY-like: quote currency JPY, k = multiplier × FX (1 × 0.0067) recovered from the notional.
      ['EURJPY', q('161.00', '161.02')],
    ]);
    const [btc, jpy] = markPositions(
      [pos(), pos({ symbol: 'EURJPY', qty: '-10000', avgPrice: '161.50', markPrice: '161.20', notional: '10800.40', marginUsed: '360.01', unrealizedPnl: '20.10' })],
      quotes,
      { now: 2_000, positionsAt: 1_500, currency: 'USD' },
    );
    expect(btc).toMatchObject({ markPrice: '65274.3', unrealizedPnl: '74.30', notional: '65274.30', marginUsed: '32637.15', live: true, stale: false });
    // Short marks at the ask: (161.02 − 161.50) × −10000 × (10800.40 / (10000 × 161.20)).
    expect(jpy!.markPrice).toBe('161.02');
    expect(jpy!.unrealizedPnl).toBe('32.16');
    expect(jpy!.live).toBe(true);
  });

  it('keeps the engine values without a quote, and flags old snapshots and stale or old quotes', () => {
    const [kept] = markPositions([pos()], new Map(), { now: 100_000, positionsAt: 1_000, currency: 'USD' });
    expect(kept).toMatchObject({ markPrice: '65214.3', unrealizedPnl: '14.30', live: false, stale: true });
    const [fresh] = markPositions([pos()], new Map(), { now: 2_000, positionsAt: 1_000, currency: 'USD' });
    expect(fresh!.stale).toBe(false);
    const [oldQuote] = markPositions([pos()], new Map([['BTCUSD', q('1', '2', 1_000)]]), { now: 20_000, positionsAt: 19_000, currency: 'USD' });
    expect(oldQuote!.stale).toBe(true);
    const [flagged] = markPositions([pos()], new Map([['BTCUSD', q('1', '2', 19_000, true)]]), { now: 20_000, positionsAt: 19_000, currency: 'USD' });
    expect(flagged!.stale).toBe(true);
    const [unpriced] = markPositions([pos({ markPrice: null, notional: null })], new Map([['BTCUSD', q('1', '2')]]), { now: 2_000, positionsAt: 1_000, currency: 'USD' });
    expect(unpriced!.live).toBe(false);
  });

  it('derives equity, day P&L, margin and loss-limit use from the same marks (one source for top bar and blotter)', () => {
    const marked = markPositions([pos()], new Map([['BTCUSD', q('65274.3', '65280.3')]]), { now: 2_000, positionsAt: 1_500, currency: 'USD' });
    const a = liveAccount(acct(), marked);
    expect(a).toMatchObject({ unrealizedPnl: '74.30', equity: '100008.38', dayPnl: '8.38', marginUsed: '32637.15', marginFree: '67371.23', marginUsedPct: '32.63', dailyLossUsedPct: '0.00' });
    const down = liveAccount(acct(), markPositions([pos()], new Map([['BTCUSD', q('65100.3', '65101')]]), { now: 2_000, positionsAt: 1_500, currency: 'USD' }));
    expect(down.dayPnl).toBe('-165.62');
    expect(down.dailyLossUsedPct).toBe('8.28');
  });

  it('keeps the engine margin total when a position has no margin figure', () => {
    const marked = markPositions([pos({ marginUsed: null })], new Map([['BTCUSD', q('65274.3', '65280.3')]]), { now: 2_000, positionsAt: 1_500, currency: 'USD' });
    const a = liveAccount(acct(), marked);
    expect(a).toMatchObject({ marginUsed: '32607.15', equity: '100008.38', marginFree: '67401.23' });
  });

  it('falls back to the engine account when the snapshots disagree or nothing is live', () => {
    const marked = markPositions([pos()], new Map([['BTCUSD', q('65274.3', '65280.3')]]), { now: 2_000, positionsAt: 1_500, currency: 'USD' });
    const a = acct({ openPositions: 2 });
    expect(liveAccount(a, marked)).toBe(a);
    const b = acct();
    expect(liveAccount(b, markPositions([pos()], new Map(), { now: 2_000, positionsAt: 1_500, currency: 'USD' }))).toBe(b);
  });

  it('newest engine snapshot wins; stale when the request failed or the snapshot is old', () => {
    const older = acct({ asOf: '2026-09-27T10:00:00.000Z' });
    const newer = acct({ asOf: '2026-09-27T10:00:05.000Z' });
    expect(newerAccount(older, newer)).toBe(newer);
    expect(newerAccount(newer, older)).toBe(newer);
    expect(newerAccount(null, older)).toBe(older);
    expect(newerAccount(older, null)).toBe(older);
    expect(accountStale({ error: true, okAt: 1_000 }, 1_500)).toBe(true);
    expect(accountStale({ error: false, okAt: null }, 1_500)).toBe(true);
    expect(accountStale({ error: false, okAt: 1_000 }, 12_000)).toBe(true);
    expect(accountStale({ error: false, okAt: 1_000 }, 5_000)).toBe(false);
  });
});
