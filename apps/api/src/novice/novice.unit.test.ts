import { describe, expect, it } from 'vitest';

import { ConfigDisclosureRegistry, retailLossPct } from '../disclosures/config-disclosure-registry';
import { loadTradingConfig } from '../trading/trading-config';
import { loadNoviceConfig } from './novice-config';

describe('disclosure registry (config-backed, goal 09 replaces it)', () => {
  it('keeps the [XX] placeholder visible until Compliance sets the figure', () => {
    const r = new ConfigDisclosureRegistry({});
    const en = r.current('risk-warning', 'en')!;
    expect(en).toMatchObject({
      version: '1',
      placeholder: true,
      values: { retailLossPct: '[XX]' },
      simulated: true,
    });
    expect(en.banner.startsWith('[XX]% of retail accounts')).toBe(true);
    expect(en.body[0]).toContain('[XX]%');
    expect(r.current('nope', 'en')).toBeNull();
  });

  it('renders the Compliance figure in EN and FR; a new figure changes the content hash', () => {
    const before = new ConfigDisclosureRegistry({}).current('risk-warning', 'en')!;
    const set = new ConfigDisclosureRegistry({ KORA_DISCLOSURE_RETAIL_LOSS_PCT: '74' });
    const en = set.current('risk-warning', 'en')!;
    const fr = set.current('risk-warning', 'fr')!;
    expect(en).toMatchObject({ placeholder: false, values: { retailLossPct: '74' } });
    expect(en.banner).toContain('74% of retail accounts');
    expect(fr.banner).toContain('74 % des comptes');
    expect(en.contentHash).not.toBe(before.contentHash);
    expect(en.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic.
    expect(
      new ConfigDisclosureRegistry({ KORA_DISCLOSURE_RETAIL_LOSS_PCT: '74' }).current(
        'risk-warning',
        'en',
      )!.contentHash,
    ).toBe(en.contentHash);
  });

  it('refuses an invalid figure at boot', () => {
    expect(retailLossPct({ KORA_DISCLOSURE_RETAIL_LOSS_PCT: '' })).toBeNull();
    expect(retailLossPct({ KORA_DISCLOSURE_RETAIL_LOSS_PCT: '74.5' })).toBe('74.5');
    expect(() => retailLossPct({ KORA_DISCLOSURE_RETAIL_LOSS_PCT: 'lots' })).toThrow(/percentage/);
    expect(() => retailLossPct({ KORA_DISCLOSURE_RETAIL_LOSS_PCT: '101' })).toThrow();
    expect(() => new ConfigDisclosureRegistry({}, [{ id: 'x' }])).toThrow();
  });
});

describe('novice settings (SIMULATED placeholders)', () => {
  it('defaults match the prototype and validate', () => {
    expect(loadNoviceConfig({})).toEqual({
      suggestedDailyLossPct: '1.5',
      suggestedMonthlyLossPct: '6',
      autoInvestMaxPct: '25',
      autoInvestMinPct: '1',
    });
    expect(() => loadNoviceConfig({ KORA_NOVICE_SUGGESTED_DAILY_LOSS_PCT: 'abc' })).toThrow();
    const t = loadTradingConfig({});
    expect(t.novice).toEqual({
      loosenDelayMs: 86_400_000,
      coolingOff: { losingTrades: 3, dailyLossPct: '5' },
      maxLeverage: '2',
    });
    expect(t.riskDefaults.monthlyLossLimit).toBeUndefined();
    expect(
      loadTradingConfig({
        KORA_RISK_MONTHLY_LOSS_LIMIT: '9000',
        KORA_NOVICE_LOOSEN_DELAY_HOURS: '1',
      }),
    ).toMatchObject({
      riskDefaults: { monthlyLossLimit: '9000' },
      novice: { loosenDelayMs: 3_600_000 },
    });
  });
});
