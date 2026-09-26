import { describe, expect, it } from 'vitest';

import { dec, Decimal, DecimalParseError, decimalPlaces, isDecimalString, quantize, roundToTick } from './decimal.js';

describe('dec', () => {
  it('parses decimal strings exactly', () => {
    expect(dec('0.1').plus(dec('0.2')).toString()).toBe('0.3');
    expect(dec(' 1.08420 ').toFixed(5)).toBe('1.08420');
    expect(dec('-12').toString()).toBe('-12');
  });
  it('accepts bigint, Decimal and safe integers', () => {
    expect(dec(10n).toString()).toBe('10');
    const d = new Decimal('2.5');
    expect(dec(d)).toBe(d);
    expect(dec(42).toString()).toBe('42');
  });
  it('rejects floats and garbage', () => {
    expect(() => dec(0.1)).toThrow(DecimalParseError);
    expect(() => dec(Number.MAX_SAFE_INTEGER + 2)).toThrow(DecimalParseError);
    expect(() => dec('1e5')).toThrow(DecimalParseError);
    expect(() => dec('abc')).toThrow(DecimalParseError);
    expect(() => dec('1.')).toThrow(DecimalParseError);
    expect(() => dec('NaN')).toThrow(DecimalParseError);
  });
});

describe('quantize / roundToTick', () => {
  it('uses banker rounding by default', () => {
    expect(quantize('1.084205', 5).toFixed(5)).toBe('1.08420');
    expect(quantize('1.084215', 5).toFixed(5)).toBe('1.08422');
    expect(quantize('2.5', 0, Decimal.ROUND_HALF_UP).toString()).toBe('3');
  });
  it('validates decimals', () => {
    expect(() => quantize('1', -1)).toThrow(RangeError);
    expect(() => quantize('1', 1.5)).toThrow(RangeError);
    expect(() => quantize('1', 19)).toThrow(RangeError);
  });
  it('rounds to tick sizes', () => {
    expect(roundToTick('5482.63', '0.25').toString()).toBe('5482.75');
    expect(roundToTick('1.084213', '0.00001').toString()).toBe('1.08421');
    expect(() => roundToTick('1', '0')).toThrow(RangeError);
  });
});

describe('helpers', () => {
  it('counts places and validates', () => {
    expect(decimalPlaces('1.08420')).toBe(5);
    expect(decimalPlaces('100')).toBe(0);
    expect(() => decimalPlaces('x')).toThrow(DecimalParseError);
    expect(isDecimalString('1.5')).toBe(true);
    expect(isDecimalString('1,5')).toBe(false);
  });
});
