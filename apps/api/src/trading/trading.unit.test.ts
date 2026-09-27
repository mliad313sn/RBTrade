import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  dec,
  Decimal,
  type AssetClassTrading,
  type FeeSchedule,
  type InstrumentSpec,
  type Venue,
} from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { LiveBrokerStub, LiveTradingDisabledError, PaperBrokerAdapter } from './broker/broker';
import { dayExpiry } from './oms.service';
import { loadTradingConfig } from './trading-config';
import type { TradableInstrument } from './trading-registry.service';
import { num } from './trading.types';

const venue = (tz: string, weekly: Venue['calendar']['weekly']): Venue => ({
  mic: 'XTST',
  isoMic: false,
  operatingMic: null,
  name: 'Test',
  country: 'US',
  region: 'north_america',
  timezone: tz,
  currency: 'USD',
  calendar: { weekly },
  calendarSource: 'test',
  status: 'active',
  simulated: true,
});
const inst = (v: Venue): TradableInstrument => ({
  spec: { symbol: 'T', tradingSessions: null } as unknown as InstrumentSpec,
  venue: v,
  fees: {} as FeeSchedule,
  trading: {} as AssetClassTrading,
  multiplier: new Decimal(1),
  staleAfterMs: 5000,
});

describe('trading config', () => {
  it('defaults are SIMULATED placeholders and validate', () => {
    const c = loadTradingConfig({});
    expect(c).toMatchObject({
      startingCash: '100000',
      baseCurrency: 'USD',
      engineEnabled: true,
      reconciliationIntervalMs: 60_000,
      rollUtcHour: 21,
    });
    expect(c.riskDefaults).toEqual({
      maxOrderNotional: '1000000',
      maxPositionNotional: '2000000',
      maxLeverage: '30',
      dailyLossLimit: '5000',
      weeklyLossLimit: '10000',
      maxOrdersPerMinute: 60,
    });
    expect(
      loadTradingConfig({ KORA_ENGINE_ENABLED: 'false', KORA_PAPER_BASE_CURRENCY: 'EUR' }),
    ).toMatchObject({ engineEnabled: false, baseCurrency: 'EUR' });
    expect(() => loadTradingConfig({ KORA_PAPER_STARTING_CASH: '1e6' })).toThrow();
    expect(() => loadTradingConfig({ KORA_PAPER_BASE_CURRENCY: 'usd' })).toThrow();
  });

  it('session override (goal 04 weekend-deterministic e2e) is refused outside dev/test', () => {
    expect([...loadTradingConfig({}).sessionOverride]).toEqual([]);
    expect([
      ...loadTradingConfig({ KORA_ENV: 'test', KORA_TRADING_SESSION_OVERRIDE: 'EURUSD, GBPUSD' })
        .sessionOverride,
    ]).toEqual(['EURUSD', 'GBPUSD']);
    expect(() =>
      loadTradingConfig({ KORA_ENV: 'production', KORA_TRADING_SESSION_OVERRIDE: 'EURUSD' }),
    ).toThrow(/refused/);
    expect(() =>
      loadTradingConfig({ KORA_ENV: 'staging', KORA_TRADING_SESSION_OVERRIDE: 'EURUSD' }),
    ).toThrow(/refused/);
    expect(() =>
      loadTradingConfig({ KORA_ENV: 'test', KORA_TRADING_SESSION_OVERRIDE: 'eurusd' }),
    ).toThrow();
  });

  it('IRTC R6-12: the session override needs KORA_ENV explicitly dev or test (unset or misspelt is refused)', () => {
    expect(() => loadTradingConfig({ KORA_TRADING_SESSION_OVERRIDE: 'EURUSD' })).toThrow(/refused/);
    expect(() =>
      loadTradingConfig({ KORA_ENV: ' ', KORA_TRADING_SESSION_OVERRIDE: 'EURUSD' }),
    ).toThrow();
    expect([
      ...loadTradingConfig({ KORA_ENV: 'dev', KORA_TRADING_SESSION_OVERRIDE: 'EURUSD' })
        .sessionOverride,
    ]).toEqual(['EURUSD']);
    // Without the override an unset KORA_ENV still loads (nothing test-only is requested).
    expect([...loadTradingConfig({}).sessionOverride]).toEqual([]);
  });

  it('IRTC R2-13: NODE_ENV=production refuses the session override even when KORA_ENV is unset', () => {
    expect(() =>
      loadTradingConfig({ NODE_ENV: 'production', KORA_TRADING_SESSION_OVERRIDE: 'EURUSD,AAPL' }),
    ).toThrow(/refused/);
    expect(() =>
      loadTradingConfig({
        NODE_ENV: 'production',
        KORA_ENV: 'test',
        KORA_TRADING_SESSION_OVERRIDE: 'EURUSD',
      }),
    ).toThrow(/refused/);
  });

  it('IRTC R2-20: margin call and close-out levels default to 100% / 50% and must be ordered', () => {
    expect(loadTradingConfig({}).margin).toEqual({
      callLevelPct: '100',
      closeOutLevelPct: '50',
      checkMs: 5000,
    });
    expect(
      loadTradingConfig({ KORA_MARGIN_CALL_LEVEL_PCT: '120', KORA_MARGIN_CLOSEOUT_LEVEL_PCT: '80' })
        .margin,
    ).toMatchObject({ callLevelPct: '120', closeOutLevelPct: '80' });
    expect(() =>
      loadTradingConfig({ KORA_MARGIN_CALL_LEVEL_PCT: '50', KORA_MARGIN_CLOSEOUT_LEVEL_PCT: '50' }),
    ).toThrow(/below/);
  });
});

describe('DAY expiry follows the venue calendar', () => {
  const nyse = venue('America/New_York', {
    mon: [['09:30', '16:00']],
    tue: [['09:30', '16:00']],
    wed: [['09:30', '16:00']],
    thu: [['09:30', '16:00']],
    fri: [['09:30', '16:00']],
  });
  it('expires at the close when the market is open', () => {
    expect(dayExpiry(inst(nyse), Date.parse('2026-09-30T14:00:00Z')).toISOString()).toBe(
      '2026-09-30T20:00:00.000Z',
    );
  });
  it('skips a lunch break and expires at the final close', () => {
    const tokyo = venue('Asia/Tokyo', {
      wed: [
        ['09:00', '11:30'],
        ['12:30', '15:30'],
      ],
    });
    expect(dayExpiry(inst(tokyo), Date.parse('2026-09-30T01:00:00Z')).toISOString()).toBe(
      '2026-09-30T06:30:00.000Z',
    );
  });
  it('24/7 venues expire at local midnight', () => {
    const crypto = venue('UTC', {
      sun: [['00:00', '24:00']],
      mon: [['00:00', '24:00']],
      tue: [['00:00', '24:00']],
      wed: [['00:00', '24:00']],
      thu: [['00:00', '24:00']],
      fri: [['00:00', '24:00']],
      sat: [['00:00', '24:00']],
    });
    expect(dayExpiry(inst(crypto), Date.parse('2026-09-30T14:00:00Z')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});

describe('broker adapters', () => {
  it('paper broker positions are an independent replay of fills', async () => {
    const b = new PaperBrokerAdapter({
      fillsFor: async () => [
        { symbol: 'A', side: 'buy', qty: '10', price: '100', multiplier: new Decimal(1) },
        { symbol: 'A', side: 'sell', qty: '4', price: '110', multiplier: new Decimal(1) },
        { symbol: 'B', side: 'sell', qty: '1', price: '5', multiplier: new Decimal(1) },
      ],
    });
    const p = await b.positions('acct');
    expect(p.map((x) => [x.symbol, x.qty.toFixed(), x.avgPrice.toFixed()])).toEqual([
      ['A', '6', '100'],
      ['B', '-1', '5'],
    ]);
    await expect(b.submit()).rejects.toThrow(/in-process/);
    await expect(b.cancel()).rejects.toThrow(/in-process/);
  });
  it('the LIVE stub always refuses', async () => {
    const off = new LiveBrokerStub({
      liveTradingEnabled: false,
      hasActiveSignoff: async () => true,
    });
    await expect(off.positions()).rejects.toBeInstanceOf(LiveTradingDisabledError);
    await expect(off.cancel()).rejects.toThrow('LIVE_TRADING_ENABLED is false');
  });
});

describe('money hygiene', () => {
  it('numeric strings are normalised without floats', () => {
    expect(num('1.08000')).toBe('1.08');
    expect(num('100.000')).toBe('100');
    expect(num('42')).toBe('42');
    expect(dec(num('0.000100')).toFixed()).toBe('0.0001');
  });
  it('trading code never parses money with floats', () => {
    const dir = __dirname;
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    const offenders = files.filter((f) =>
      /parseFloat\(|\.toNumber\(\)|Number\((?!\(|\s*\()[^)]*(price|qty|amount|cash|equity|pnl)/i.test(
        readFileSync(join(dir, f), 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
