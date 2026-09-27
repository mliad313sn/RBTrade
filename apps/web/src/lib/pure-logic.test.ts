// Goal 10 test-pyramid audit: pure web logic below 85 % line coverage (formatting, layout
// validation, proxy address parsing, lesson keys).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { forwardedClient, trustedProxyHops } from './forwarded';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtPctNumber, fmtTime } from './i18n/format';
import { GLOSSARY, isLesson, lessonKeys, LESSONS, termKeys } from './novice/learn';
import {
  clockLabel,
  displayName,
  formatClock,
  formatQty,
  formatSpread,
  midOf,
} from './terminal/format';
import {
  buildDefaultLayout,
  clearLocalLayout,
  defaultSizes,
  isCompleteLayout,
  loadLocalLayout,
  PANEL_IDS,
  saveLocalLayout,
} from './terminal/layout';

describe('i18n money and number formatting', () => {
  it('English keeps the symbol-first style; French moves the symbol and swaps separators', () => {
    expect(fmtMoney('10482.3', 'USD', 'en')).toBe('$10,482.30');
    const n = '\u202f'; // narrow no-break space
    expect(fmtMoney('10482.3', 'USD', 'fr')).toBe(`10${n}482,30${n}$`);
    expect(fmtMoney('1500', 'JPY', 'fr')).toBe(`1${n}500${n}¥`);
    expect(fmtMoney('12.5', 'SEK', 'fr')).toBe(`12,50${n}SEK`);
    expect(fmtMoney(3, 'EUR', 'fr', { decimals: 0 })).toBe(`3${n}€`);
    expect(fmtMoney('abc', 'USD', 'en')).toBe('—');
  });
  it('percentages and plain numbers', () => {
    expect(fmtPctNumber('4.82', 'en', { decimals: 2 })).toBe('4.82');
    expect(fmtPctNumber('4.82', 'fr', { decimals: 2 })).toBe('4,82');
    expect(fmtPctNumber('x', 'en')).toBe('—');
    expect(fmtNumber('1.5', 'fr')).toBe('1,5');
    expect(fmtNumber(2, 'en')).toBe('2');
  });
  it('dates in a given zone, and a dash for invalid input', () => {
    const iso = '2026-09-28T14:00:00Z';
    expect(fmtDateTime(iso, 'en', 'UTC')).toMatch(/Mon.*28.*Sep.*14:00/);
    expect(fmtDate(iso, 'fr', 'UTC')).toMatch(/28 sept/);
    expect(fmtTime(iso, 'en', 'UTC')).toBe('14:00');
    expect(fmtTime(iso, 'en')).toMatch(/^\d{2}:\d{2}$/);
    for (const f of [fmtDateTime, fmtDate, fmtTime]) expect(f('nope', 'en')).toBe('—');
  });
});

describe('terminal formatting', () => {
  it('clock in UTC or local time', () => {
    expect(formatClock(Date.UTC(2026, 8, 27, 14, 3, 27), 'utc')).toBe('14:03:27');
    expect(formatClock('2026-09-27T14:03:27Z', 'local')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatClock('bad', 'utc')).toBe('—');
    expect(clockLabel('utc')).toBe('UTC');
    expect(clockLabel('local')).toBe('Local');
  });
  it('quantities, spreads, mids and names from the registry', () => {
    expect(formatQty('100000', 0)).toBe('100,000');
    expect(formatQty('0.8000', 4)).toBe('0.8');
    expect(formatQty('-2.5', 2)).toBe('2.5');
    expect(formatQty('n/a', 2)).toBe('n/a');
    expect(
      formatSpread('1.08410', '1.08422', {
        pipSize: '0.0001',
        tickSize: '0.00001',
        pricePrecision: 5,
      }),
    ).toBe('1.2 pip');
    expect(
      formatSpread('64811.5', '64813.5', { pipSize: null, tickSize: '0.5', pricePrecision: 1 }),
    ).toBe('2.0');
    expect(midOf('1.08410', '1.08422', 5)).toBe('1.08416');
    expect(displayName({ displayName: 'EUR/USD', symbol: 'EURUSD' }, 'EURUSD')).toBe('EUR/USD');
    expect(displayName(null, 'EURUSD')).toBe('EURUSD');
  });
});

describe('terminal layout', () => {
  afterEach(() => vi.unstubAllGlobals());

  const complete = () => ({
    panels: Object.fromEntries(PANEL_IDS.map((id) => [id, { id }])),
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { views: ['chart', 'watchlist', 'calendar'] } },
          {
            type: 'branch',
            data: [{ type: 'leaf', data: { views: ['orderbook', 'trades', 'ticket'] } }],
          },
        ],
      },
    },
    floatingGroups: [{ data: { views: ['positions', 'orders', 'fills', 'alerts', 'risk'] } }],
  });

  it('default sizes follow the 2/7/3 grid and the blotter rule', () => {
    expect(defaultSizes(1440, 900)).toEqual({
      left: 237,
      right: 356,
      blotter: 203,
      calendar: 90,
      orderbook: 270,
    });
    expect(defaultSizes(1440, 1100).blotter).toBe(240);
    expect(defaultSizes(0, 100)).toMatchObject({ left: 0, right: 0, blotter: 160, orderbook: 200 });
  });

  it('accepts a layout that places every panel once, rejects partial, duplicated or foreign ones', () => {
    expect(isCompleteLayout(complete())).toBe(true);
    expect(isCompleteLayout(null)).toBe(false);
    expect(isCompleteLayout({ panels: {} })).toBe(false);
    const missing = complete();
    delete (missing.panels as Record<string, unknown>).risk;
    expect(isCompleteLayout(missing)).toBe(false);
    const foreign = complete();
    (foreign.panels as Record<string, unknown>).evil = {};
    expect(isCompleteLayout(foreign)).toBe(false);
    const twice = complete();
    twice.floatingGroups[0]!.data.views.push('chart');
    expect(isCompleteLayout(twice)).toBe(false);
  });

  it('builds the default layout with every panel', () => {
    const added: string[] = [];
    const group = { api: { setSize: vi.fn() } };
    const api = {
      width: 1392,
      height: 836,
      clear: vi.fn(),
      addPanel: vi.fn((p: { id: string }) => added.push(p.id)),
      getPanel: vi.fn(() => ({ group, api: { setActive: vi.fn() } })),
    };
    buildDefaultLayout(api as never);
    expect(api.clear).toHaveBeenCalled();
    expect([...added].sort()).toEqual([...PANEL_IDS].sort());
    expect(group.api.setSize).toHaveBeenCalled();
  });

  it('local storage: saves, loads only complete layouts, clears, and survives a broken storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    expect(loadLocalLayout()).toBeNull();
    saveLocalLayout(complete() as never);
    expect(loadLocalLayout()).toEqual(complete());
    store.set('kora.terminal.layout.v1', '{broken');
    expect(loadLocalLayout()).toBeNull();
    clearLocalLayout();
    expect(store.size).toBe(0);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
        removeItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(loadLocalLayout()).toBeNull();
    expect(() => saveLocalLayout(complete() as never)).not.toThrow();
    expect(() => clearLocalLayout()).not.toThrow();
  });
});

describe('proxy address and lessons', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('takes the hops-th address from the right only when hops are configured', () => {
    expect(forwardedClient('6.6.6.6, 10.0.0.9', 1)).toBe('10.0.0.9');
    expect(forwardedClient('6.6.6.6, 10.0.0.9', 2)).toBe('6.6.6.6');
    expect(forwardedClient('6.6.6.6', 0)).toBe('127.0.0.1');
    expect(forwardedClient('not an ip', 1)).toBe('127.0.0.1');
    expect(forwardedClient(null, 1)).toBe('127.0.0.1');
    vi.stubEnv('KORA_TRUSTED_PROXY_HOPS', '1');
    expect(trustedProxyHops()).toBe(1);
    vi.stubEnv('KORA_TRUSTED_PROXY_HOPS', '9');
    expect(trustedProxyHops()).toBe(0);
  });
  it('lesson and glossary keys', () => {
    expect(isLesson('costs')).toBe(true);
    expect(isLesson('crypto-moon')).toBe(false);
    expect(lessonKeys(LESSONS[0]).paragraphs).toHaveLength(4);
    expect(termKeys(GLOSSARY[0])).toEqual({
      name: 'term.spread.name',
      meaning: 'term.spread.meaning',
    });
  });
});
