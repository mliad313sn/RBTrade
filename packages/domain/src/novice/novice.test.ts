import { describe, expect, it } from 'vitest';

import { dec } from '../decimal.js';
import { STRATEGY_TEMPLATES } from '../strategy/templates.js';
import { coolingOff, nextUtcDay } from './cooling-off.js';
import { applyLimitChanges, effectiveOwnLimits, pendingChanges } from './limits.js';
import { changeSinceStart, suggestedLimit, worstDip } from './summary.js';
import { noviceTemplates, templateRiskLevel } from './templates.js';
import { buildNoviceOrder, minimumAmount, scenarioGain } from './ticket.js';

const eur = {
  bid: '1.08410',
  ask: '1.08420',
  tickSize: '0.00001',
  qtyStep: '1000',
  minQty: '1000',
  multiplier: '1',
  fxRate: '1',
  accountCcy: 'USD',
};

describe('novice ticket', () => {
  it('turns an amount into a quantity on the grid (rounded down) and a stop away from the entry', () => {
    const r = buildNoviceOrder({ ...eur, direction: 'up', amount: '5000', safetyNetPct: '3' });
    expect(r).toMatchObject({ ok: true, side: 'buy', qty: '4000', refPrice: '1.0842' });
    if (!r.ok) throw new Error('expected ok');
    // 1.0842 × 0.97 = 1.051674 → floor to the tick.
    expect(r.stopLossPrice).toBe('1.05167');
    expect(r.amountUsed).toBe('4336.80');
    const s = buildNoviceOrder({ ...eur, direction: 'down', amount: '5000', safetyNetPct: '3' });
    if (!s.ok) throw new Error('expected ok');
    // Sell: sized on the bid, stop above (1.0841 × 1.03 = 1.116623 → ceil).
    expect(s).toMatchObject({ side: 'sell', refPrice: '1.0841', stopLossPrice: '1.11663' });
  });

  it('refuses an amount below the minimum quantity and says what the minimum is', () => {
    const r = buildNoviceOrder({ ...eur, direction: 'up', amount: '500', safetyNetPct: '3' });
    expect(r).toEqual({ ok: false, reason: 'amount_too_small', minAmount: '1084.20' });
    expect(minimumAmount({ ...eur, direction: 'down' })).toBe('1084.10');
  });

  it('uses the FX rate and multiplier for other quote currencies', () => {
    // Toyota: 100 shares minimum at ¥3,000, account in USD at 0.0067.
    const r = buildNoviceOrder({
      bid: '3000',
      ask: '3001',
      tickSize: '1',
      qtyStep: '100',
      minQty: '100',
      multiplier: '1',
      fxRate: '0.0067',
      accountCcy: 'USD',
      direction: 'up',
      amount: '5000',
      safetyNetPct: '2.5',
    });
    expect(r).toMatchObject({ ok: true, qty: '200', stopLossPrice: '2925' });
  });

  it('rejects invalid input and safety nets outside 0.5–10 %', () => {
    expect(buildNoviceOrder({ ...eur, direction: 'up', amount: 'abc', safetyNetPct: '3' }).ok).toBe(
      false,
    );
    expect(
      buildNoviceOrder({ ...eur, direction: 'up', amount: '5000', safetyNetPct: '0.1' }),
    ).toMatchObject({ reason: 'invalid' });
    expect(
      buildNoviceOrder({ ...eur, direction: 'up', amount: '5000', safetyNetPct: '11' }),
    ).toMatchObject({ reason: 'invalid' });
  });

  it('gain scenario = gross move − costs, never negative, in the account currency', () => {
    expect(scenarioGain({ price: '15.00', costs: '1.50' }, 'USD')).toBe('13.50');
    expect(scenarioGain({ price: '1.00', costs: '1.50' }, 'USD')).toBe('0.00');
    expect(scenarioGain({ price: '1500', costs: '12' }, 'JPY')).toBe('1488');
  });
});

describe('guarded limit changes', () => {
  const t0 = Date.parse('2026-09-26T10:00:00Z');
  const day = 24 * 3600_000;
  const current = (stored: Record<string, unknown>, now: number) => (f: string) =>
    effectiveOwnLimits(stored, now)[f] ?? (f === 'dailyLossLimit' ? '5000' : undefined);

  it('tightening applies now; loosening waits and then applies itself', () => {
    let stored: Record<string, unknown> = { dailyLossLimit: '150' };
    const tight = applyLimitChanges(
      stored,
      { dailyLossLimit: '100' },
      current(stored, t0),
      t0,
      day,
    );
    expect(tight.applied).toEqual({ dailyLossLimit: '100' });
    expect(tight.pending).toEqual({});
    stored = tight.stored;
    const loose = applyLimitChanges(
      stored,
      { dailyLossLimit: '300' },
      current(stored, t0),
      t0,
      day,
    );
    expect(loose.applied).toEqual({});
    expect(loose.pending.dailyLossLimit).toMatchObject({
      value: '300',
      effectiveAt: '2026-09-27T10:00:00.000Z',
    });
    stored = loose.stored;
    expect(effectiveOwnLimits(stored, t0 + day - 1).dailyLossLimit).toBe('100');
    expect(pendingChanges(stored, t0 + day - 1)).toHaveLength(1);
    expect(effectiveOwnLimits(stored, t0 + day).dailyLossLimit).toBe('300');
    expect(pendingChanges(stored, t0 + day)).toHaveLength(0);
  });

  it('a tightening drops a pending loosening of the same field; others stay pending', () => {
    const s1 = applyLimitChanges(
      { dailyLossLimit: '150', monthlyLossLimit: '600' },
      { dailyLossLimit: '300', monthlyLossLimit: '900' },
      (f) => (f === 'dailyLossLimit' ? '150' : '600'),
      t0,
      day,
    ).stored;
    const s2 = applyLimitChanges(
      s1,
      { dailyLossLimit: '120' },
      (f) => effectiveOwnLimits(s1, t0)[f],
      t0 + 1000,
      day,
    );
    expect(s2.applied).toEqual({ dailyLossLimit: '120' });
    expect(pendingChanges(s2.stored, t0 + 1000).map((p) => p.field)).toEqual(['monthlyLossLimit']);
  });

  it('setting a limit that did not exist yet counts as loosening only when above the current value', () => {
    const first = applyLimitChanges({}, { monthlyLossLimit: '600' }, () => undefined, t0, day);
    expect(first.pending.monthlyLossLimit).toBeDefined();
    const within = applyLimitChanges({}, { dailyLossLimit: '150' }, () => '5000', t0, day);
    expect(within.applied).toEqual({ dailyLossLimit: '150' });
  });

  it('with no delay (Pro users) everything applies at once', () => {
    const r = applyLimitChanges(
      { dailyLossLimit: '100' },
      { dailyLossLimit: '900' },
      () => '100',
      t0,
      0,
    );
    expect(r.applied).toEqual({ dailyLossLimit: '900' });
    expect(r.stored.pending).toBeUndefined();
  });
});

describe('cooling-off', () => {
  const base = {
    losingTradesToday: 0,
    dayPnl: dec('0'),
    dayStartEquity: dec('10000'),
    dailyLossLimit: '150',
  };
  it('three losing trades, a 5 % day loss, or the daily limit', () => {
    expect(coolingOff(base)).toMatchObject({ active: false, reason: null, dayLossPct: '0.00' });
    expect(coolingOff({ ...base, losingTradesToday: 2 }).active).toBe(false);
    expect(coolingOff({ ...base, losingTradesToday: 3 })).toMatchObject({
      active: true,
      reason: 'losing_trades',
    });
    expect(coolingOff({ ...base, dailyLossLimit: '99999', dayPnl: dec('-499.99') }).active).toBe(
      false,
    );
    expect(coolingOff({ ...base, dailyLossLimit: '99999', dayPnl: dec('-500') })).toMatchObject({
      reason: 'daily_loss_pct',
      dayLossPct: '5.00',
    });
    expect(coolingOff({ ...base, dayPnl: dec('-150') })).toMatchObject({
      reason: 'daily_loss_limit',
    });
    expect(coolingOff({ ...base, dayPnl: dec('40') }).dayLossPct).toBe('0.00');
  });
  it('custom thresholds and the next UTC day', () => {
    expect(
      coolingOff({ ...base, losingTradesToday: 1 }, { losingTrades: 1, dailyLossPct: '5' }).active,
    ).toBe(true);
    expect(nextUtcDay(Date.parse('2026-09-26T23:59:59Z'))).toBe('2026-09-27T00:00:00.000Z');
  });
});

describe('home summary numbers', () => {
  it('worst dip is the largest fall from a previous high', () => {
    const d = worstDip(
      [
        { t: 'a', equity: '10000' },
        { t: 'b', equity: '10200' },
        { t: 'c', equity: '9986' },
        { t: 'd', equity: '10482.30' },
        { t: 'e', equity: '10400' },
      ],
      'USD',
    );
    expect(d).toEqual({ amount: '214.00', pct: '2.10', at: 'c' });
    expect(worstDip([{ t: 'a', equity: '100' }], 'USD')).toEqual({
      amount: '0.00',
      pct: '0.00',
      at: null,
    });
  });
  it('change since start and suggested limits', () => {
    expect(changeSinceStart('10000', '10482.30', 'USD')).toEqual({ amount: '482.30', pct: '4.82' });
    expect(changeSinceStart('0', '5', 'USD').pct).toBe('0.00');
    expect(suggestedLimit('10000', '1.5')).toBe('150');
    expect(suggestedLimit('100000', '6')).toBe('6000');
    expect(suggestedLimit('10', '1.5')).toBe('1');
  });
});

describe('auto-invest risk levels', () => {
  it('follow the documented rule and match the prototype (Steady Trend 2, Gold Balance 3)', () => {
    const t = Object.fromEntries(noviceTemplates().map((x) => [x.id, x]));
    expect(t['trend-x']).toMatchObject({
      riskLevel: 2,
      factors: ['mixed_markets', 'small_amounts'],
    });
    expect(t['meanrev-gold']).toMatchObject({
      riskLevel: 3,
      factors: ['mixed_markets', 'single_market', 'small_amounts'],
    });
    expect(t['breakout-crypto']).toMatchObject({
      riskLevel: 5,
      factors: ['crypto_markets', 'wide_safety_net'],
    });
    expect(noviceTemplates()).toHaveLength(STRATEGY_TEMPLATES.length);
  });
  it('clamps to 1–5 and treats unknown classes as 3', () => {
    const def = STRATEGY_TEMPLATES[0]!.definition;
    expect(
      templateRiskLevel({ ...def, universe: { ...def.universe, symbols: ['EURUSD'] } }, () => 'fx')
        .level,
    ).toBe(2);
    expect(
      templateRiskLevel({ ...def, universe: { ...def.universe, symbols: ['X'] } }, () => 'unknown')
        .level,
    ).toBe(4);
  });
});
