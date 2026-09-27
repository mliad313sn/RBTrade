import { describe, expect, it } from 'vitest';

import { retailLossSentence } from './retail-loss';

describe('retail-loss sentence (IRTC R4-18)', () => {
  it('shows the figure Compliance published in the registry', () => {
    expect(retailLossSentence('74.5')).toBe('74.5% of retail CFD accounts lose money with this provider.');
  });

  it('stays an explicit placeholder until then', () => {
    for (const v of [null, undefined, '', '[XX]'])
      expect(retailLossSentence(v)).toContain('[XX]% of retail CFD accounts lose money with this provider: [INSERT REGULATORY FIGURE].');
  });
});
