import { describe, expect, it } from 'vitest';

import { fmtNum, fmtRatioPct, fmtSigned } from '../robots/format';
import { displayDirection, safeLocale } from './format';
import { watchRowView } from './views';

describe('IRTC R5 low findings', () => {
  it('R5-18: an invalid browser language tag never reaches Intl (chart stays drawn)', () => {
    expect(safeLocale('en-US@posix')).toBe('en-US');
    expect(safeLocale('')).toBe('en-US');
    expect(safeLocale(undefined)).toBe('en-US');
    expect(safeLocale('fr-fr')).toBe('fr-FR');
    expect(() => new Date(0).toLocaleString(safeLocale('en-US@posix'))).not.toThrow();
  });

  it('R5-19: no direction glyph or colour on values that display as zero; no negative zero', () => {
    expect(displayDirection('0.001', 2)).toBe('flat');
    expect(displayDirection('-0.004', 2)).toBe('flat');
    expect(displayDirection('-0.006', 2)).toBe('down');
    expect(displayDirection(0.02, 2)).toBe('up');
    expect(displayDirection('abc', 2)).toBe('flat');
    const spec = { pricePrecision: 5, pipSize: '0.0001', tickSize: '0.00001' };
    // Mid 1.08400 vs day open 1.084001: −0.0001 % → shown "0.00%", so flat.
    expect(watchRowView({ bid: '1.08400', ask: '1.08400' }, '1.084001', spec)).toMatchObject({
      change: '0.00%',
      dir: 'flat',
    });
    expect(watchRowView({ bid: '1.09400', ask: '1.09400' }, '1.08400', spec).dir).toBe('up');
    expect(fmtRatioPct(-0.0001)).toBe('0.0%');
    expect(fmtNum(-0.0001, 2)).toBe('0.00');
    expect(fmtNum(-1, 2)).toBe('−1.00');
    expect(fmtSigned(-0.001, 2)).toBe('0.00');
    expect(fmtSigned(0.5, 1, '%')).toBe('+0.5%');
  });
});
