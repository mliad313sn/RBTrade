import { ASSET_CLASSES } from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { SEED_INSTRUMENTS } from '../seed/instruments.js';
import { SEED_VENUES } from '../seed/venues.js';
import { CONTINENTS, continentOf, PROVIDER_MATRIX } from './matrix.js';

describe('provider adapter matrix (goal 07B)', () => {
  it('every entry is a flagged, unlicensed stub tied to an open question', () => {
    for (const p of PROVIDER_MATRIX) {
      expect(p.flagged).toBe(true);
      expect(p.licensed).toBe(false);
      expect(p.flag).toMatch(/^KORA_[A-Z_]+$/);
      expect(['OQ-M3', 'OQ-M4']).toContain(p.openQuestion);
      expect(p.licensingNeed.length).toBeGreaterThan(10);
    }
  });

  it('lists market data and news sources on every continent', () => {
    for (const c of CONTINENTS) {
      expect(
        PROVIDER_MATRIX.some((p) => p.kind === 'market_data' && p.continents.includes(c)),
      ).toBe(true);
      expect(PROVIDER_MATRIX.some((p) => p.kind === 'news' && p.continents.includes(c))).toBe(true);
    }
  });

  it('covers every seeded venue and asset class', () => {
    const venues = new Set(PROVIDER_MATRIX.flatMap((p) => p.venues));
    for (const v of SEED_VENUES) expect(venues.has(v.mic)).toBe(true);
    const classes = new Set(
      PROVIDER_MATRIX.filter((p) => p.kind === 'market_data').flatMap((p) => p.assetClasses),
    );
    for (const a of ASSET_CLASSES) expect(classes.has(a)).toBe(true);
  });

  it('the registry has at least one venue with instruments per continent', () => {
    for (const c of CONTINENTS) {
      const mics = SEED_VENUES.filter((v) => continentOf(v.region) === c).map((v) => v.mic);
      expect(SEED_INSTRUMENTS.some((i) => mics.includes(i.venue))).toBe(true);
    }
    expect(continentOf('global')).toBe('global');
  });
});
