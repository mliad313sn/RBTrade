import type { Quote } from '@kora/domain';
import type { VenueDto, WebSocketCtor, WebSocketLike } from '@kora/sdk';
import { describe, expect, it } from 'vitest';

import {
  hasModifier,
  hotkeyParts,
  isTypingTarget,
  isValidHotkey,
  matchHotkey,
  parseHotkey,
} from './hotkeys';
import { defaultSizes, isCompleteLayout, PANEL_IDS } from './layout';
import { MarketStore, percentile } from './market-store';
import { groupHits, searchInstruments } from './registry';
import { mergeOrders } from './trading';
import { bookView, orderLine, protectiveLevels, watchRowView } from './views';
import { formatClock, formatQty, formatSpread } from './format';

const key = (
  k: string,
  code: string,
  mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {},
) => ({
  key: k,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('hotkeys', () => {
  it('parses and matches modifiers, Mod per platform, digits by physical key', () => {
    expect(parseHotkey('Ctrl+Shift+K')).toEqual({
      key: 'K',
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
    });
    expect(parseHotkey('Hyper+K')).toBeNull();
    expect(matchHotkey(key('k', 'KeyK', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+K')).toBe(
      true,
    );
    expect(matchHotkey(key('k', 'KeyK', { ctrlKey: true }), 'Ctrl+Shift+K')).toBe(false);
    expect(matchHotkey(key('k', 'KeyK', { metaKey: true }), 'Mod+K', true)).toBe(true);
    expect(matchHotkey(key('k', 'KeyK', { ctrlKey: true }), 'Mod+K', false)).toBe(true);
    expect(matchHotkey(key('¡', 'Digit1', { altKey: true }), 'Alt+1', true)).toBe(true); // macOS Option+1
    expect(matchHotkey(key('b', 'KeyB'), 'B')).toBe(true);
    expect(matchHotkey(key('B', 'KeyB', { shiftKey: true }), 'B')).toBe(false);
    expect(matchHotkey(key('Enter', 'Enter', { ctrlKey: true }), 'Ctrl+Enter')).toBe(true);
    expect(matchHotkey(key('?', 'Slash', { shiftKey: true }), 'Shift+?')).toBe(true);
    expect(matchHotkey(key('Escape', 'Escape'), 'Esc')).toBe(true);
    expect(
      matchHotkey(
        { key: 'x', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
        'X',
      ),
    ).toBe(true);
  });
  it('typing targets, modifiers, display and validation', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(
      false,
    );
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(hasModifier('Ctrl+Enter')).toBe(true);
    expect(hasModifier('B')).toBe(false);
    expect(hotkeyParts('Mod+K', true)).toEqual(['⌘', 'K']);
    expect(hotkeyParts('Alt+1', false)).toEqual(['Alt', '1']);
    expect(isValidHotkey('Ctrl+Alt+K')).toBe(true);
    expect(isValidHotkey('Foo+K')).toBe(false);
  });
});

describe('layout', () => {
  it('2 / 7 / 3 columns and the blotter height follow the prototype', () => {
    const s = defaultSizes(1392, 836);
    expect(s.left).toBe(229);
    expect(s.right).toBe(344);
    expect(s.blotter).toBe(188);
    expect(defaultSizes(1900, 1100).blotter).toBe(240);
  });
  it('accepts only layouts that place every panel exactly once', () => {
    const panels = Object.fromEntries(PANEL_IDS.map((id) => [id, { id }]));
    const leaf = (views: string[]) => ({ type: 'leaf', data: { views } });
    const ok = {
      panels,
      grid: {
        root: {
          type: 'branch',
          data: [
            leaf(['chart', 'watchlist', 'calendar']),
            leaf(['orderbook', 'trades', 'ticket']),
            leaf(['positions', 'orders', 'fills', 'alerts', 'risk']),
          ],
        },
      },
    };
    expect(isCompleteLayout(ok)).toBe(true);
    expect(
      isCompleteLayout({ ...ok, grid: { root: { type: 'branch', data: [leaf(['chart'])] } } }),
    ).toBe(false);
    expect(isCompleteLayout({ panels: { chart: {} }, grid: {} })).toBe(false);
    expect(isCompleteLayout(null)).toBe(false);
    expect(isCompleteLayout({ ...ok, floatingGroups: [{ data: { views: ['chart'] } }] })).toBe(
      false,
    ); // placed twice
  });
});

class FakeWs implements WebSocketLike {
  static last: FakeWs | null = null;
  readyState = 1;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
    FakeWs.last = this;
    queueMicrotask(() => this.onopen?.({}));
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  push(ch: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ ch, data }) });
  }
}

describe('market store: frame batching and tick-to-paint bookkeeping', () => {
  it('delivers the latest quote once per frame, ref-counts channels and records tick-to-paint', async () => {
    const frames: Array<() => void> = [];
    let clock = 0;
    const store = new MarketStore({
      url: 'ws://x/ws',
      WebSocket: FakeWs as unknown as WebSocketCtor,
      schedule: (cb) => frames.push(cb),
      now: () => clock,
    });
    const got: string[] = [];
    const off1 = store.onQuote('EURUSD', (q) => got.push(q.bid));
    const off2 = store.onQuote('EURUSD', () => undefined);
    await Promise.resolve();
    await Promise.resolve();
    const q = (bid: string): Partial<Quote> => ({
      symbol: 'EURUSD',
      bid,
      ask: '1.1',
      stale: false,
    });
    FakeWs.last!.push('quotes:EURUSD', q('1.0'));
    clock = 3;
    FakeWs.last!.push('quotes:EURUSD', q('1.01'));
    expect(got).toEqual([]);
    expect(frames).toHaveLength(1);
    clock = 10;
    frames.shift()!(); // flush: latest value only
    expect(got).toEqual(['1.01']);
    expect(store.lastQuote('EURUSD')?.bid).toBe('1.01');
    clock = 26;
    frames.shift()!(); // next frame: painted
    expect(store.perf.ticks).toEqual([26]);
    expect(store.perf.frames).toBe(1);
    // A late subscriber gets the last value immediately.
    const late: string[] = [];
    const off3 = store.onQuote('EURUSD', (x) => late.push(x.bid));
    expect(late).toEqual(['1.01']);
    off1();
    off2();
    off3();
    expect(FakeWs.last!.sent.some((s) => s.includes('unsubscribe'))).toBe(true);
    // Prints accumulate within a frame.
    const prints: number[] = [];
    store.onTrades('BTCUSD', (b) => prints.push(b.trades.length));
    await Promise.resolve();
    FakeWs.last!.push('trades:BTCUSD', { type: 'trades', symbol: 'BTCUSD', trades: [{}, {}] });
    FakeWs.last!.push('trades:BTCUSD', { type: 'trades', symbol: 'BTCUSD', trades: [{}] });
    frames.shift()!();
    expect(prints).toEqual([3]);
    store.close();
    expect(percentile([5, 1, 9, 3], 0.5)).toBe(3);
    expect(percentile([], 0.9)).toBeNull();
  });
});

describe('trading stream merge', () => {
  const o = (id: string, status: string, createdAt: string) => ({ id, status, createdAt }) as never;
  it('keeps open orders, drops closed ones, newest first', () => {
    const cur = [o('a', 'working', '2026-01-01T00:00:01Z')];
    const next = mergeOrders(cur, [
      o('b', 'working', '2026-01-01T00:00:02Z'),
      o('a', 'filled', '2026-01-01T00:00:01Z'),
    ]);
    expect(next.map((x: { id: string }) => x.id)).toEqual(['b']);
  });
});

describe('view models', () => {
  const spec = { pricePrecision: 5, pipSize: '0.0001', tickSize: '0.00001' };
  it('watchlist row: mid, change vs day open, spread in pips', () => {
    const v = watchRowView({ bid: '1.08419', ask: '1.08421' }, '1.08225', spec);
    expect(v).toEqual({
      mid: '1.08420',
      last: '1.08420',
      change: '+0.18%',
      dir: 'up',
      spread: '0.2 pip',
    });
    expect(
      watchRowView({ bid: '1', ask: '1' }, null, {
        pricePrecision: 2,
        pipSize: null,
        tickSize: '0.01',
      }),
    ).toMatchObject({ change: null, dir: 'flat', spread: '0.00' });
  });
  it('order book: cumulative Decimal totals, depth bars, mid and spread', () => {
    const b = bookView(
      {
        bids: [
          ['1.08419', '3100000'],
          ['1.08417', '1800000'],
        ],
        asks: [['1.08421', '2100000']],
      },
      10,
    );
    expect(b.bids.map((l) => l.total)).toEqual(['3100000', '4900000']);
    expect(b.bids[1]!.depth).toBe(1);
    expect(b.asks[0]!.depth).toBeCloseTo(2.1 / 4.9, 6);
    expect(b.mid).toBe('1.0842');
    expect(b.spread).toBe('0.00002');
    expect(bookView({ bids: [], asks: [] }).mid).toBeNull();
  });
  it('order lines: limit and stop are draggable, trailing is not, closed orders are not drawn', () => {
    expect(
      orderLine({ execType: 'limit', limitPrice: '1.08', stopPrice: null, status: 'working' }),
    ).toEqual({ price: '1.08', field: 'limitPrice', draggable: true });
    expect(
      orderLine({
        execType: 'stop_limit',
        limitPrice: '1.1',
        stopPrice: '1.09',
        status: 'working',
      }),
    ).toEqual({ price: '1.09', field: 'stopPrice', draggable: true });
    expect(
      orderLine({ execType: 'trailing', limitPrice: null, stopPrice: '1.07', status: 'working' })
        ?.draggable,
    ).toBe(false);
    expect(
      orderLine({ execType: 'limit', limitPrice: '1.08', stopPrice: null, status: 'filled' }),
    ).toBeNull();
    expect(
      orderLine({ execType: 'market', limitPrice: null, stopPrice: null, status: 'working' }),
    ).toBeNull();
  });
  it('protective levels: stop and target of an open position', () => {
    const ord = (p: Record<string, unknown>) =>
      ({
        symbol: 'EURUSD',
        side: 'sell',
        reduceOnly: true,
        role: 'oco_leg',
        execType: 'stop',
        stopPrice: null,
        limitPrice: null,
        ...p,
      }) as never;
    const lv = protectiveLevels(
      [
        ord({ stopPrice: '1.07' }),
        ord({ execType: 'limit', limitPrice: '1.1' }),
        ord({ side: 'buy', stopPrice: '9' }),
      ],
      { symbol: 'EURUSD', qty: '100000' },
    );
    expect([
      (lv.stop as { stopPrice: string } | null)?.stopPrice,
      (lv.target as { limitPrice: string } | null)?.limitPrice,
    ]).toEqual(['1.07', '1.1']);
    expect(protectiveLevels([], { symbol: 'EURUSD', qty: '-1' })).toEqual({
      stop: null,
      target: null,
    });
  });
  it('formatting helpers', () => {
    expect(formatClock(Date.parse('2026-09-28T11:07:32Z'), 'utc')).toBe('11:07:32');
    expect(formatClock('nope', 'utc')).toBe('—');
    expect(formatQty('-200000', 0)).toBe('200,000');
    expect(formatQty('0.8000', 4)).toBe('0.8');
    expect(
      formatSpread('64812.0', '64813.0', { pipSize: null, tickSize: '0.5', pricePrecision: 1 }),
    ).toBe('1.0');
  });
});

describe('registry search (⌘K)', () => {
  const inst = (
    symbol: string,
    displayName: string,
    venue: string,
    assetClass: string,
    isin: string | null = null,
  ) => ({ symbol, displayName, venue, assetClass, isin, venueSymbol: null }) as never;
  const venues = new Map<string, VenueDto>([
    ['XOFF', { region: 'global' } as VenueDto],
    ['XTKS', { region: 'asia' } as VenueDto],
    ['XNAS', { region: 'north_america' } as VenueDto],
  ]);
  const all = [
    inst('EURUSD', 'EUR/USD', 'XOFF', 'fx'),
    inst('7203.XTKS', 'Toyota Motor', 'XTKS', 'equity', 'JP3633400001'),
    inst('AAPL', 'Apple Inc.', 'XNAS', 'equity', 'US0378331005'),
    inst('EURJPY', 'EUR/JPY', 'XOFF', 'fx'),
  ];
  it('matches symbol, display name, ISIN and MIC; exact first', () => {
    expect(searchInstruments('EUR/USD', all, venues)[0]!.instrument.symbol).toBe('EURUSD');
    expect(searchInstruments('us0378331005', all, venues).map((h) => h.instrument.symbol)).toEqual([
      'AAPL',
    ]);
    expect(searchInstruments('XTKS', all, venues).map((h) => h.instrument.symbol)).toEqual([
      '7203.XTKS',
    ]);
    expect(searchInstruments('eur', all, venues).map((h) => h.instrument.symbol)).toEqual([
      'EURJPY',
      'EURUSD',
    ]);
    expect(searchInstruments('', all, venues)).toHaveLength(4);
  });
  it('groups by region then asset class', () => {
    const g = groupHits(searchInstruments('', all, venues));
    expect(g.map((x) => `${x.region}/${x.assetClass}`)).toEqual([
      'north_america/equity',
      'asia/equity',
      'global/fx',
    ]);
  });
});
