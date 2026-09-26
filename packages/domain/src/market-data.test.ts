import { describe, expect, it } from 'vitest';

import {
  assetClassLabel,
  bucketStart,
  candleChannel,
  depthChannel,
  isTimeframe,
  parseChannel,
  QuoteSchema,
  quoteChannel,
  STATUS_CHANNEL,
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
} from './market-data.js';

describe('market data schema helpers', () => {
  it('labels derivative classes by underlying', () => {
    expect(assetClassLabel('cfd', 'index')).toBe('Index CFD');
    expect(assetClassLabel('future', 'agri')).toBe('Agri Future');
    expect(assetClassLabel('fx')).toBe('FX');
    expect(assetClassLabel('equity', 'index')).toBe('Equity');
  });

  it('aligns buckets to UTC', () => {
    const t = Date.parse('2026-09-25T10:17:42.123Z');
    expect(new Date(bucketStart(t, '15m')).toISOString()).toBe('2026-09-25T10:15:00.000Z');
    expect(new Date(bucketStart(t, '4h')).toISOString()).toBe('2026-09-25T08:00:00.000Z');
    expect(new Date(bucketStart(t, '1D')).toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(TIMEFRAMES.every((tf) => TIMEFRAME_SECONDS[tf] > 0)).toBe(true);
    expect(isTimeframe('15m')).toBe(true);
    expect(isTimeframe('2m')).toBe(false);
  });

  it('builds and parses channels', () => {
    expect(parseChannel(quoteChannel('EURUSD'))).toEqual({ kind: 'quotes', symbol: 'EURUSD', tf: null });
    expect(parseChannel(depthChannel('7203.XTKS'))).toEqual({ kind: 'depth', symbol: '7203.XTKS', tf: null });
    expect(parseChannel(candleChannel('BTCUSD', '1D'))).toEqual({ kind: 'candles', symbol: 'BTCUSD', tf: '1D' });
    expect(parseChannel(STATUS_CHANNEL)).toEqual({ kind: 'status', symbol: null, tf: null });
    for (const bad of ['quotes:', 'quotes:eurusd', 'candles:EURUSD:2m', 'candles:EURUSD', 'depth:A:B', 'trades:EURUSD', '']) {
      expect(parseChannel(bad)).toBeNull();
    }
  });

  it('validates quotes: decimal strings only', () => {
    const q = {
      type: 'quote', symbol: 'EURUSD', bid: '1.08419', ask: '1.08421', bidSize: '1000000', askSize: '500000',
      stale: false, source: 'simulated', exchangeTs: 1, receivedTs: 2, seq: 3,
    };
    expect(QuoteSchema.safeParse(q).success).toBe(true);
    expect(QuoteSchema.safeParse({ ...q, bid: 1.08419 }).success).toBe(false);
    expect(QuoteSchema.safeParse({ ...q, ask: '0' }).success).toBe(false);
    expect(QuoteSchema.safeParse({ ...q, bidSize: '-1' }).success).toBe(false);
  });
});
