import { describe, expect, it } from 'vitest';

import { Decimal, dec } from '../decimal.js';
import type { FeeSchedule } from './costs.js';
import { computePreview, type PreviewInput } from './preview.js';

/**
 * Hand-computed preview fixtures (goal 03 acceptance). Fee schedules and margin rates are the
 * SIMULATED registry placeholders seeded by migration 0003 / goal 02. Arithmetic in the comments.
 */
const fee = (p: Partial<FeeSchedule>): FeeSchedule => ({
  id: 'x',
  commissionBps: '0',
  commissionPerUnit: '0',
  commissionMin: '0',
  swapLongBps: '0',
  swapShortBps: '0',
  fxConversionBps: '25',
  simulated: true,
  ...p,
});
const FX = fee({ id: 'sim-fx', commissionBps: '0.2' });
const METAL = fee({ id: 'sim-metal', commissionBps: '1' });
const CRYPTO = fee({ id: 'sim-crypto', commissionBps: '10' });
const XNAS = fee({ id: 'sim-equity-xnas', commissionPerUnit: '0.005', commissionMin: '1' });
const XETR = fee({ id: 'sim-equity-xetr', commissionBps: '5' });

const base = (p: Partial<PreviewInput>): PreviewInput => ({
  side: 'buy',
  qty: dec('1'),
  execType: 'market',
  quote: { bid: dec('1'), ask: dec('1') },
  depth: null,
  walk: {
    tickSize: '0.00001',
    impactTicks: '0',
    volFactor: '0',
    maxLevels: 10,
    lastMidMove: new Decimal(0),
  },
  pricePrecision: 5,
  multiplier: new Decimal(1),
  quoteCcy: 'USD',
  baseCcy: 'USD',
  fees: FX,
  marginRate: dec('0.0333'),
  fxRate: new Decimal(1),
  equity: dec('100000'),
  marginUsed: new Decimal(0),
  positionQty: new Decimal(0),
  confirm: { mode: 'above_thresholds', notionalAbove: dec('50000'), lossPctAbove: dec('1') },
  ...p,
});

describe('order preview — hand-computed fixtures', () => {
  it('EUR/USD: buy 100,000 at 1.08421, stop 20 pips, target 40 pips', () => {
    const r = computePreview(
      base({
        qty: dec('100000'),
        quote: { bid: dec('1.08419'), ask: dec('1.08421') },
        stopLossPrice: dec('1.08221'),
        takeProfitPrice: dec('1.08821'),
      }),
    );
    expect(r.estimatedPrice).toBe('1.08421');
    expect(r.notional).toEqual({ quote: '108421.00', quoteCcy: 'USD', base: '108421.00' }); // 100,000 × 1.08421
    // commission 108,421 × 0.2 bps = 2.16842 → 2.17; spread (0.00002 / 2) × 100,000 = 1.00
    expect(r.fees).toEqual({
      commission: '2.17',
      spread: '1.00',
      fxConversion: '0.00',
      total: '3.17',
    });
    // margin 108,421 × 0.0333 = 3,610.4193; free = 100,000 − 3.17 − 3,610.4193 = 96,386.4107
    expect(r.margin).toMatchObject({
      rate: '0.0333',
      required: '3610.42',
      change: '3610.42',
      usedAfter: '3610.42',
      freeAfter: '96386.41',
    });
    // loss 0.00200 × 100,000 = 200.00; costs 2.17 entry + (108,221 × 0.2 bps = 2.16442 → 2.16) exit = 4.33
    expect(r.lossIfStopHit).toEqual({
      stopPrice: '1.08221',
      price: '200.00',
      costs: '4.33',
      total: '204.33',
      pctEquity: '0.20',
    });
    expect(r.rewardIfTargetHit).toEqual({ targetPrice: '1.08821', amount: '400.00' });
    expect(r.rewardRisk).toBe('2.00');
    expect(r.fx).toBeNull();
    expect(r.confirmation).toEqual({
      required: true,
      reasons: [expect.stringContaining('above your 50000.00 USD')],
    });
  });

  it('XAU/USD: sell 10 oz at 2,395.30', () => {
    const r = computePreview(
      base({
        side: 'sell',
        qty: dec('10'),
        quote: { bid: dec('2395.30'), ask: dec('2395.50') },
        fees: METAL,
        marginRate: dec('0.05'),
        pricePrecision: 2,
        walk: {
          tickSize: '0.01',
          impactTicks: '0',
          volFactor: '0',
          maxLevels: 10,
          lastMidMove: new Decimal(0),
        },
        stopLossPrice: dec('2405.30'),
        takeProfitPrice: dec('2375.30'),
      }),
    );
    expect(r.notional.base).toBe('23953.00'); // 10 × 2,395.30
    // commission 23,953 × 1 bp = 2.3953 → 2.40; spread 0.10 × 10 = 1.00
    expect(r.fees).toEqual({
      commission: '2.40',
      spread: '1.00',
      fxConversion: '0.00',
      total: '3.40',
    });
    // margin 23,953 × 0.05 = 1,197.65; free = 100,000 − 3.40 − 1,197.65
    expect(r.margin).toMatchObject({ required: '1197.65', freeAfter: '98798.95' });
    // loss 10.00 × 10 = 100.00; exit commission 24,053 × 1 bp = 2.4053 → 2.41
    expect(r.lossIfStopHit).toEqual({
      stopPrice: '2405.30',
      price: '100.00',
      costs: '4.81',
      total: '104.81',
      pctEquity: '0.10',
    });
    expect(r.rewardIfTargetHit?.amount).toBe('200.00');
    expect(r.rewardRisk).toBe('2.00');
  });

  it('BTC/USD: buy 0.5 at 64,813.5', () => {
    const r = computePreview(
      base({
        qty: dec('0.5'),
        quote: { bid: dec('64811.5'), ask: dec('64813.5') },
        fees: CRYPTO,
        marginRate: dec('0.50'),
        pricePrecision: 1,
        walk: {
          tickSize: '0.1',
          impactTicks: '0',
          volFactor: '0',
          maxLevels: 10,
          lastMidMove: new Decimal(0),
        },
        stopLossPrice: dec('63813.5'),
        takeProfitPrice: dec('66813.5'),
      }),
    );
    expect(r.notional.base).toBe('32406.75'); // 0.5 × 64,813.5
    // commission 32,406.75 × 10 bps = 32.40675 → 32.41; spread 1.0 × 0.5 = 0.50
    expect(r.fees).toEqual({
      commission: '32.41',
      spread: '0.50',
      fxConversion: '0.00',
      total: '32.91',
    });
    // margin 32,406.75 × 0.5 = 16,203.375 → 16,203.38 (half-even); free 100,000 − 32.91 − 16,203.375 = 83,763.715 → 83,763.72
    expect(r.margin).toMatchObject({ required: '16203.38', freeAfter: '83763.72' });
    // loss 1,000 × 0.5 = 500.00; exit commission 31,906.75 × 10 bps = 31.90675 → 31.91; costs 64.32
    expect(r.lossIfStopHit).toEqual({
      stopPrice: '63813.5',
      price: '500.00',
      costs: '64.32',
      total: '564.32',
      pctEquity: '0.56',
    });
    expect(r.rewardIfTargetHit?.amount).toBe('1000.00');
    expect(r.rewardRisk).toBe('2.00');
  });

  it('equity AAPL: buy 100 shares at 221.38 (per-share commission with a minimum)', () => {
    const r = computePreview(
      base({
        qty: dec('100'),
        quote: { bid: dec('221.36'), ask: dec('221.38') },
        fees: XNAS,
        marginRate: dec('0.20'),
        pricePrecision: 2,
        walk: {
          tickSize: '0.01',
          impactTicks: '0',
          volFactor: '0',
          maxLevels: 10,
          lastMidMove: new Decimal(0),
        },
        stopLossPrice: dec('216.38'),
        takeProfitPrice: dec('231.38'),
      }),
    );
    expect(r.notional.base).toBe('22138.00');
    // commission max(100 × 0.005 = 0.50, 1.00 minimum) = 1.00; spread 0.01 × 100 = 1.00
    expect(r.fees).toEqual({
      commission: '1.00',
      spread: '1.00',
      fxConversion: '0.00',
      total: '2.00',
    });
    expect(r.margin).toMatchObject({ required: '4427.60', freeAfter: '95570.40' }); // 22,138 × 0.20
    expect(r.lossIfStopHit).toEqual({
      stopPrice: '216.38',
      price: '500.00',
      costs: '2.00',
      total: '502.00',
      pctEquity: '0.50',
    });
    expect(r.rewardRisk).toBe('2.00');
  });

  it('SAP (EUR) in a USD account: FX-converted notional, fees, margin and conversion cost', () => {
    const r = computePreview(
      base({
        qty: dec('50'),
        quote: { bid: dec('202.38'), ask: dec('202.42') },
        quoteCcy: 'EUR',
        fees: XETR,
        marginRate: dec('0.20'),
        pricePrecision: 2,
        fxRate: dec('1.0842'),
        walk: {
          tickSize: '0.02',
          impactTicks: '0',
          volFactor: '0',
          maxLevels: 10,
          lastMidMove: new Decimal(0),
        },
      }),
    );
    // 50 × 202.42 = 10,121.00 EUR; × 1.0842 = 10,973.1882 USD
    expect(r.notional).toEqual({ quote: '10121.00', quoteCcy: 'EUR', base: '10973.19' });
    // commission 10,121 × 5 bps = 5.0605 → 5.06 EUR → 5.486052 USD; conversion 25 bps = 0.013715...;
    // spread 0.02 × 50 = 1.00 EUR → 1.0842 USD; total 6.58396...
    expect(r.fees).toEqual({
      commission: '5.49',
      spread: '1.08',
      fxConversion: '0.01',
      total: '6.58',
    });
    expect(r.margin.required).toBe('2194.64'); // 10,973.1882 × 0.20
    expect(r.fx).toEqual({
      from: 'EUR',
      to: 'USD',
      rate: '1.0842',
      conversionBps: '25',
      conversionCost: '0.01',
    });
    expect(r.lossIfStopHit).toBeNull();
    expect(r.confirmation.reasons).toEqual(['No stop loss: the loss on this order is not capped.']);
  });
});

describe('order preview — behaviour', () => {
  const eur = { qty: dec('100000'), quote: { bid: dec('1.08419'), ask: dec('1.08421') } };

  it('walks visible depth, flags partial fills and prices the remainder at the last level', () => {
    const r = computePreview(
      base({
        ...eur,
        qty: dec('300000'),
        depth: {
          bids: [],
          asks: [
            ['1.08421', '100000'],
            ['1.08423', '100000'],
          ],
        },
      }),
    );
    expect(r.exceedsVisibleDepth).toBe(true);
    // (100k × 1.08421 + 200k × 1.08423) / 300k = 1.084223333…
    expect(r.estimatedPriceExact.toFixed(9)).toBe('1.084223333');
    expect(r.estimatedPrice).toBe('1.08422');
  });

  it('limit, stop, stop-limit and trailing estimates', () => {
    expect(
      computePreview(base({ ...eur, execType: 'limit', limitPrice: dec('1.08300') }))
        .estimatedPrice,
    ).toBe('1.08300');
    const marketable = computePreview(
      base({
        ...eur,
        execType: 'limit',
        limitPrice: dec('1.08500'),
        depth: { bids: [], asks: [['1.08421', '50000']] },
      }),
    );
    expect(marketable.estimatedPriceExact.toFixed(6)).toBe('1.084605'); // half at 1.08421, half at the limit
    expect(
      computePreview(base({ ...eur, execType: 'stop', stopPrice: dec('1.08600') })).estimatedPrice,
    ).toBe('1.08600');
    expect(
      computePreview(
        base({
          ...eur,
          execType: 'stop_limit',
          stopPrice: dec('1.08600'),
          limitPrice: dec('1.08610'),
        }),
      ).estimatedPrice,
    ).toBe('1.08610');
    expect(
      computePreview(
        base({ ...eur, side: 'sell', execType: 'trailing', trailAmount: dec('0.00100') }),
      ).estimatedPrice,
    ).toBe('1.08319');
    expect(
      computePreview(base({ ...eur, execType: 'trailing', trailAmount: dec('0.00100') }))
        .estimatedPrice,
    ).toBe('1.08521');
  });

  it('flags stop loss and take profit on the wrong side', () => {
    const r = computePreview(
      base({ ...eur, stopLossPrice: dec('1.09000'), takeProfitPrice: dec('1.08000') }),
    );
    expect(r.issues.map((i) => i.code)).toEqual(['STOP_LOSS_WRONG_SIDE', 'TAKE_PROFIT_WRONG_SIDE']);
    expect(r.lossIfStopHit).toBeNull();
    expect(r.rewardRisk).toBeNull();
  });

  it('reducing orders free margin; confirmation modes', () => {
    const r = computePreview(
      base({
        ...eur,
        side: 'sell',
        positionQty: dec('100000'),
        marginUsed: dec('3610.4193'),
        confirm: { mode: 'never', notionalAbove: dec('0'), lossPctAbove: dec('0') },
      }),
    );
    expect(r.margin.change).toBe('-3610.35'); // closing at the bid: 108,419 × 0.0333
    expect(r.confirmation).toEqual({ required: false, reasons: [] });
    const always = computePreview(
      base({
        ...eur,
        confirm: { mode: 'always', notionalAbove: dec('0'), lossPctAbove: dec('0') },
      }),
    );
    expect(always.confirmation.reasons[0]).toMatch(/every order/);
    const loss = computePreview(
      base({ ...eur, qty: dec('1000'), stopLossPrice: dec('1.00000'), equity: dec('1000') }),
    );
    expect(loss.confirmation.reasons.some((x) => x.includes('% of equity'))).toBe(true);
    const broke = computePreview(base({ ...eur, stopLossPrice: dec('1.08221'), equity: dec('0') }));
    expect(broke.lossIfStopHit?.pctEquity).toBe('100.00');
  });
});
