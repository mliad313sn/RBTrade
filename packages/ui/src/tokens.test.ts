import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tokensCss } from '../scripts/build-css';
import { contrastRatio } from './lib/contrast';
import { contrastPairs, conventions, nonTextPairs, themes } from './tokens';

describe('design tokens', () => {
  it('match the committee palette exactly', () => {
    expect(themes['pro-dark']).toMatchObject({ bg: '#0B0E13', panel: '#11151C', raised: '#1A202A', border: '#262E3B', text: '#E6EAF0', textMuted: '#9AA4B2', up: '#4DA3FF', down: '#FF9F40', ai: '#A78BFA', warn: '#F2C94C', kill: '#FF4D6D' });
    expect(themes['novice-light']).toMatchObject({ bg: '#F7F5F0', panel: '#FFFFFF', text: '#1C2430', up: '#1D6FD1', down: '#B8520B', accent: '#3E5BD8' });
  });
  it('every declared text pair is >= 4.5:1 in both themes and all colour conventions', () => {
    for (const t of Object.values(themes)) {
      for (const [fg, bg] of contrastPairs(t)) expect(contrastRatio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
    }
    for (const [name, convs] of Object.entries(conventions)) {
      const t = themes[name as keyof typeof themes];
      for (const c of Object.values(convs)) for (const s of [t.bg, t.panel, t.raised]) {
        expect(contrastRatio(c.up, s)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.down, s)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('convention surfaces keep direction text readable; meaning graphics meet 3:1 (IRTC R5-15, R5-16)', () => {
    for (const [name, convs] of Object.entries(conventions)) {
      const t = themes[name as keyof typeof themes];
      const surfaces = new Set<string>();
      for (const c of Object.values(convs)) {
        expect(contrastRatio(c.up, c.upSurface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.down, c.downSurface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.text, c.upSurface)).toBeGreaterThanOrEqual(4.5);
        surfaces.add(c.upSurface);
      }
      // Each convention has its own surface (the depth bars follow the prices' palette).
      expect(surfaces.size).toBe(3);
      expect(convs.blue_orange.upSurface).toBe(t.upSurface);
      for (const [fg, bg] of nonTextPairs()) expect(contrastRatio(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
    }
    expect(tokensCss()).toContain("[data-theme='pro-dark'][data-colors='red_up_asia'], [data-theme='pro-dark'] [data-colors='red_up_asia'] {\n  --k-up: #FF6B6B;\n  --k-down: #3FB950;\n  --k-up-surface: #3A1616;");
  });
  it('contrast maths matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(() => contrastRatio('red', '#fff')).toThrow();
  });
  it('generated CSS is in sync with tokens.ts', () => {
    const onDisk = readFileSync(resolve(__dirname, 'styles/tokens.generated.css'), 'utf8');
    expect(onDisk).toBe(tokensCss());
  });
});
