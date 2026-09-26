import { describe, expect, it } from 'vitest';

import { direction, formatDecimal, formatMoney, formatPercent, formatPrice, spokenDirection } from './format';

describe('formatters (decimal-safe)', () => {
  it('formats prices at instrument precision', () => {
    expect(formatPrice('1.0842', 5)).toBe('1.08420');
    expect(formatPrice('148.2154', 3)).toBe('148.215'); // half-even
    expect(formatPrice('64812.5', 1)).toBe('64,812.5');
    expect(formatPrice('0.1', 0)).toBe('0');
  });
  it('never loses precision like floats do', () => {
    expect(formatDecimal('0.30000000000000004', 2)).toBe('0.30');
    expect(formatDecimal('12345678901234567.89', 2)).toBe('12,345,678,901,234,567.89');
  });
  it('signs and minus', () => {
    expect(formatDecimal('1284.5', 2, { signed: true })).toBe('+1,284.50');
    expect(formatDecimal('-200', 2, { signed: true })).toBe('−200.00');
    expect(formatDecimal('0', 2, { signed: true })).toBe('0.00');
    expect(formatDecimal('-0.001', 2)).toBe('0.00');
    expect(formatDecimal('1000', 0, { grouping: false })).toBe('1000');
  });
  it('formats money in code and symbol styles', () => {
    expect(formatMoney('108420.69', 'USD')).toBe('108,420.69 USD');
    expect(formatMoney('10482.3', 'USD', { display: 'symbol' })).toBe('$10,482.30');
    expect(formatMoney('-16.5', 'USD', { display: 'symbol' })).toBe('−$16.50');
    expect(formatMoney('41.2', 'USD', { display: 'symbol', signed: true })).toBe('+$41.20');
    expect(formatMoney('1500', 'JPY')).toBe('1,500 JPY');
    expect(formatMoney('1', 'CHF', { display: 'symbol' })).toBe('1.00 CHF');
  });
  it('formats percent and direction', () => {
    expect(formatPercent('0.0018')).toBe('+0.18%');
    expect(formatPercent('-0.0135')).toBe('−1.35%');
    expect(direction('0.1')).toBe('up');
    expect(direction('-0.1')).toBe('down');
    expect(direction('0')).toBe('flat');
    expect(spokenDirection('0')).toBe('unchanged');
    expect(spokenDirection('-2')).toBe('down');
  });
});
