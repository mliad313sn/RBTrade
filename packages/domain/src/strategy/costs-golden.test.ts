import { describe, expect, it } from 'vitest';

import { dec } from '../decimal.js';
import { commission, type FeeSchedule } from '../trading/costs.js';

/**
 * Golden vectors shared with the quant backtester (services/quant/tests/test_bt_metrics_costs.py):
 * the backtest cost model must charge exactly what the paper engine charges.
 */
const fs = (over: Partial<FeeSchedule>): FeeSchedule => ({
  id: 'golden',
  commissionBps: '0',
  commissionPerUnit: '0',
  commissionMin: '0',
  swapLongBps: '0',
  swapShortBps: '0',
  fxConversionBps: '0',
  simulated: true,
  ...over,
});

describe('commission golden vectors (paper engine = backtester)', () => {
  it.each([
    [{ commissionBps: '0.2' }, '100000', '1.08421', '1', '2.17'],
    [{ commissionPerUnit: '0.005', commissionMin: '1' }, '100', '221.38', '1', '1.00'],
    [{ commissionPerUnit: '0.005', commissionMin: '1' }, '1000', '221.38', '1', '5.00'],
    [{ commissionBps: '10' }, '0.8', '64813.5', '1', '51.85'],
    [{ commissionPerUnit: '0.005' }, '1', '1', '1', '0.00'],
    [{ commissionPerUnit: '0.005' }, '3', '1', '1', '0.02'],
    [{ commissionPerUnit: '1.5' }, '2', '5000', '50', '3.00'],
  ])('%j qty %s @ %s ×%s → %s', (f, qty, price, mult, expected) => {
    expect(commission(fs(f), dec(qty), dec(price), dec(mult), 'USD').toFixed(2)).toBe(expected);
  });
});
