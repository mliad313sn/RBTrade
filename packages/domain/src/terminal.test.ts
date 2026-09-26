import { describe, expect, it } from 'vitest';

import { dec } from './decimal.js';
import {
  alertTriggered,
  CreateAlertSchema,
  CreateWatchlistSchema,
  pipsBetween,
  pipSizeOf,
  protectivePrice,
  quoteBadge,
  roundQtyDown,
  SaveLayoutSchema,
  sessionBadge,
  ticketWarnings,
  unitsFromQtyInput,
  UpdateWatchlistSchema,
} from './terminal.js';

const EURUSD = { pipSize: '0.0001', tickSize: '0.00001' };
const AAPL = { pipSize: null, tickSize: '0.01' };

describe('ticket quantity modes', () => {
  it('units round down onto the registry grid', () => {
    expect(
      unitsFromQtyInput({
        mode: 'units',
        value: '1234.9',
        price: null,
        multiplier: '1',
        qtyStep: '1',
      })!.toFixed(),
    ).toBe('1234');
    expect(roundQtyDown(dec('0.01239'), '0.0001').toFixed()).toBe('0.0123');
  });

  it('notional in the account currency → units via price × multiplier × FX', () => {
    // 108,420 USD at 1.08420 → 100,000 EUR units
    expect(
      unitsFromQtyInput({
        mode: 'notional',
        value: '108420',
        price: '1.08420',
        multiplier: '1',
        qtyStep: '1',
      })!.toFixed(),
    ).toBe('100000');
    // A EUR account buying a USD instrument: 1 USD = 0.9 EUR; 9,000 EUR buys 10,000 USD of AAPL at 200 = 50 shares
    expect(
      unitsFromQtyInput({
        mode: 'notional',
        value: '9000',
        price: '200',
        multiplier: '1',
        qtyStep: '1',
        fxRate: '0.9',
      })!.toFixed(),
    ).toBe('50');
    // contract multiplier (e.g. 1,000 barrels)
    expect(
      unitsFromQtyInput({
        mode: 'notional',
        value: '100000',
        price: '78.14',
        multiplier: '1000',
        qtyStep: '1',
      })!.toFixed(),
    ).toBe('1');
  });

  it('% of equity', () => {
    // 10 % of 250,000 = 25,000 USD of BTC at 62,500 = 0.4 BTC
    expect(
      unitsFromQtyInput({
        mode: 'pct_equity',
        value: '10',
        price: '62500',
        multiplier: '1',
        qtyStep: '0.0001',
        equity: '250000',
      })!.toFixed(),
    ).toBe('0.4');
    expect(
      unitsFromQtyInput({
        mode: 'pct_equity',
        value: '10',
        price: '62500',
        multiplier: '1',
        qtyStep: '0.0001',
      }),
    ).toBeNull();
  });

  it('incomplete or invalid input gives null', () => {
    expect(
      unitsFromQtyInput({ mode: 'units', value: '', price: null, multiplier: '1', qtyStep: '1' }),
    ).toBeNull();
    expect(
      unitsFromQtyInput({
        mode: 'units',
        value: 'abc',
        price: null,
        multiplier: '1',
        qtyStep: '1',
      }),
    ).toBeNull();
    expect(
      unitsFromQtyInput({ mode: 'units', value: '0', price: null, multiplier: '1', qtyStep: '1' }),
    ).toBeNull();
    expect(
      unitsFromQtyInput({
        mode: 'notional',
        value: '100',
        price: null,
        multiplier: '1',
        qtyStep: '1',
      }),
    ).toBeNull();
    expect(
      unitsFromQtyInput({
        mode: 'notional',
        value: '100',
        price: '0',
        multiplier: '1',
        qtyStep: '1',
      }),
    ).toBeNull();
  });
});

describe('SL/TP distance modes', () => {
  it('pips use the registry pip size; stop below / target above for a buy (prototype 20 / 40 pips)', () => {
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'pips',
        value: '20',
        side: 'buy',
        entry: '1.08421',
        spec: EURUSD,
      })!.toFixed(),
    ).toBe('1.08221');
    expect(
      protectivePrice({
        kind: 'tp',
        mode: 'pips',
        value: '40',
        side: 'buy',
        entry: '1.08421',
        spec: EURUSD,
      })!.toFixed(),
    ).toBe('1.08821');
  });

  it('sell side mirrors; percent of entry; price mode rounds to tick', () => {
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'pips',
        value: '20',
        side: 'sell',
        entry: '1.08419',
        spec: EURUSD,
      })!.toFixed(),
    ).toBe('1.08619');
    expect(
      protectivePrice({
        kind: 'tp',
        mode: 'percent',
        value: '5',
        side: 'sell',
        entry: '200',
        spec: AAPL,
      })!.toFixed(),
    ).toBe('190');
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'percent',
        value: '2.5',
        side: 'buy',
        entry: '221.37',
        spec: AAPL,
      })!.toFixed(2),
    ).toBe('215.84');
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'price',
        value: '1.082214',
        side: 'buy',
        entry: null,
        spec: EURUSD,
      })!.toFixed(),
    ).toBe('1.08221');
  });

  it('instruments without pips fall back to the tick size; invalid inputs give null', () => {
    expect(pipSizeOf(AAPL).toFixed()).toBe('0.01');
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'pips',
        value: '50',
        side: 'buy',
        entry: '221.37',
        spec: AAPL,
      })!.toFixed(2),
    ).toBe('220.87');
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'pips',
        value: '20',
        side: 'buy',
        entry: null,
        spec: EURUSD,
      }),
    ).toBeNull();
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'pips',
        value: '',
        side: 'buy',
        entry: '1',
        spec: EURUSD,
      }),
    ).toBeNull();
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'pips',
        value: '0',
        side: 'buy',
        entry: '1',
        spec: EURUSD,
      }),
    ).toBeNull();
    expect(
      protectivePrice({
        kind: 'sl',
        mode: 'percent',
        value: '150',
        side: 'buy',
        entry: '1',
        spec: EURUSD,
      }),
    ).toBeNull();
    expect(pipsBetween('1.08421', '1.08221', EURUSD).toFixed()).toBe('20');
  });
});

describe('ticket warnings', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const events = [
    { time: '2026-09-28T12:30:00Z', currency: 'USD', title: 'CPI (m/m)', impact: 3 as const },
    { time: '2026-09-28T14:00:00Z', currency: 'EUR', title: 'ECB speaker', impact: 2 as const },
    { time: '2026-09-28T11:00:00Z', currency: 'USD', title: 'Past', impact: 1 as const },
  ];
  const base = {
    perTradeRiskPct: '1',
    hasStop: true,
    events,
    currencies: ['EUR', 'USD'],
    now,
    session: 'open',
    dataState: 'ok',
  };

  it('risk above the per-trade rule, and an event within 60 minutes', () => {
    const w = ticketWarnings({ ...base, lossPctEquity: '1.25' });
    expect(w.map((x) => x.code)).toEqual(['RISK_ABOVE_RULE', 'EVENT_SOON']);
    expect(w[1]!.message).toContain('USD CPI (m/m) in 30 min');
  });

  it('no warning within the rule and outside the window; closed session, stale data and no stop', () => {
    expect(ticketWarnings({ ...base, lossPctEquity: '1', currencies: ['JPY'] })).toEqual([]);
    const w = ticketWarnings({
      ...base,
      lossPctEquity: null,
      hasStop: false,
      currencies: ['GBP'],
      session: 'closed',
      dataState: 'feed_not_ok',
    });
    expect(w.map((x) => x.code)).toEqual(['NO_STOP', 'SESSION_NOT_OPEN', 'DATA_NOT_OK']);
    expect(w[1]!.message).toContain('Market closed');
    expect(
      ticketWarnings({ ...base, lossPctEquity: null, currencies: [], session: 'break' })[0]!
        .message,
    ).toContain('Market break');
  });
});

describe('session and quote badges (B-208)', () => {
  it('market closed is not stale', () => {
    expect(quoteBadge({ stale: true, session: 'closed' })).toBe('closed');
    expect(quoteBadge({ stale: true, session: 'open' })).toBe('stale');
    expect(quoteBadge({ stale: false, session: 'open' })).toBeNull();
    expect(quoteBadge({ stale: false, session: null })).toBeNull();
    expect(sessionBadge('open')).toEqual({ label: 'Open', tone: 'open' });
    expect(sessionBadge('closed').label).toBe('Closed');
    expect(sessionBadge('holiday').label).toBe('Holiday');
    expect(sessionBadge('break').label).toBe('Break');
    expect(sessionBadge(undefined).label).toBe('Unknown');
  });
});

describe('terminal request schemas', () => {
  it('watchlists: names, unique symbols, max 500', () => {
    expect(CreateWatchlistSchema.parse({ name: 'Majors' }).symbols).toEqual([]);
    expect(
      CreateWatchlistSchema.safeParse({ name: 'x', symbols: ['EURUSD', 'EURUSD'] }).success,
    ).toBe(false);
    expect(CreateWatchlistSchema.safeParse({ name: '<script>', symbols: [] }).success).toBe(false);
    expect(
      CreateWatchlistSchema.safeParse({
        name: 'ok',
        symbols: Array.from({ length: 501 }, (_, i) => `S${i}`),
      }).success,
    ).toBe(false);
    expect(UpdateWatchlistSchema.safeParse({ symbols: ['7203.XTKS', 'eurusd'] }).success).toBe(
      false,
    );
    expect(UpdateWatchlistSchema.safeParse({ position: 2 }).success).toBe(true);
  });

  it('alerts: RSI bounds, timeframe only for indicators', () => {
    expect(
      CreateAlertSchema.safeParse({ symbol: 'EURUSD', condition: 'price_above', threshold: '1.09' })
        .success,
    ).toBe(true);
    expect(
      CreateAlertSchema.safeParse({
        symbol: 'EURUSD',
        condition: 'rsi_above',
        threshold: '70',
        timeframe: '15m',
      }).success,
    ).toBe(true);
    expect(
      CreateAlertSchema.safeParse({ symbol: 'EURUSD', condition: 'rsi_above', threshold: '120' })
        .success,
    ).toBe(false);
    expect(
      CreateAlertSchema.safeParse({
        symbol: 'EURUSD',
        condition: 'price_below',
        threshold: '1',
        timeframe: '1m',
      }).success,
    ).toBe(false);
    expect(
      CreateAlertSchema.safeParse({ symbol: 'EURUSD', condition: 'price_below', threshold: '-1' })
        .success,
    ).toBe(false);
    expect(SaveLayoutSchema.safeParse({ layout: { grid: {} } }).success).toBe(true);
  });

  it('alert trigger rule', () => {
    expect(alertTriggered('price_above', '1.09', dec('1.09'))).toBe(true);
    expect(alertTriggered('price_above', '1.09', dec('1.08999'))).toBe(false);
    expect(alertTriggered('price_below', '1.09', dec('1.08'))).toBe(true);
    expect(alertTriggered('rsi_below', '30', 29.5)).toBe(true);
    expect(alertTriggered('rsi_above', '70', 69.9)).toBe(false);
  });
});
