import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dec, decimalPlaces, type AssetClass, type InstrumentSpec } from '@kora/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertPriceSpec,
  floatToPrice,
  floatToQty,
  formatPrice,
  formatQty,
  formatVolume,
  isOnTick,
  RegistrySpecError,
  roundQty,
  toPips,
} from './precision.js';
import { SEED_INSTRUMENTS } from './seed/instruments.js';
import { simProfileFor } from './seed/sim-profiles.js';
import { SimulatedMarket } from './sim/simulated-market.js';

/**
 * Acceptance: precision and tick rounding come from the registry, never hard-coded.
 * Arbitrary registry rows (odd ticks like 0.25, 5, 0.015625, 0.0025) drive the simulator and the
 * rounding helpers; every emitted value must sit on that row's grid.
 */

const TICKS: Array<[string, number]> = [
  ['0.00001', 5],
  ['0.0001', 4],
  ['0.001', 3],
  ['0.005', 3],
  ['0.01', 2],
  ['0.02', 2],
  ['0.05', 2],
  ['0.1', 1],
  ['0.25', 2],
  ['0.5', 1],
  ['1', 0],
  ['5', 0],
  ['0.015625', 6],
  ['0.0025', 4],
  ['0.2', 3],
];
const STEPS: Array<[string, string, number]> = [
  ['1', '1', 0],
  ['1000', '1000', 0],
  ['0.0001', '0.0001', 4],
  ['0.01', '0.01', 2],
  ['0.1', '0.1', 1],
  ['100', '100', 0],
  ['0.001', '0.005', 3],
];
const CLASSES: AssetClass[] = [
  'fx',
  'metal',
  'crypto',
  'equity',
  'etf',
  'bond',
  'future',
  'option',
  'energy',
  'agri',
  'index',
  'cfd',
  'fund',
];

const specArb: fc.Arbitrary<InstrumentSpec> = fc
  .record({
    tick: fc.constantFrom(...TICKS),
    extraPrecision: fc.integer({ min: 0, max: 2 }),
    qty: fc.constantFrom(...STEPS),
    cls: fc.constantFrom(...CLASSES),
    refMult: fc.integer({ min: 20, max: 200_000 }),
  })
  .map(({ tick, extraPrecision, qty, cls, refMult }) => ({
    ...SEED_INSTRUMENTS[0]!,
    symbol: 'PROP',
    assetClass: cls,
    tickSize: tick[0],
    pricePrecision: tick[1] + extraPrecision,
    qtyStep: qty[0],
    minQty: qty[1],
    qtyPrecision: qty[2],
    // reference price = refMult ticks, so every magnitude from sub-unit to large index levels appears
    pipSize: null,
    marginRates: {},
    tradingSessions: null,
    feeScheduleId: 'prop',
    venueSymbol: String(refMult),
  }));

const onGrid = (v: string, step: string, places: number) =>
  dec(v).mod(dec(step)).isZero() && decimalPlaces(v) === places;

describe('registry-driven precision (fast-check)', () => {
  it('simulator output lands on the registry grid for arbitrary specs and seeds', () => {
    fc.assert(
      fc.property(specArb, fc.integer(), (spec, seed) => {
        const profile = {
          ...simProfileFor(spec),
          refPrice: dec(spec.tickSize).mul(Number(spec.venueSymbol)).toFixed(),
        };
        const m = new SimulatedMarket({
          seed,
          startTs: 0,
          instruments: [{ spec, profile }],
          depthLevels: 5,
        });
        for (let i = 0; i < 40; i++) {
          const o = m.step().outputs[0]!;
          const q = o.quote;
          if (!q) continue;
          for (const p of [
            q.bid,
            q.ask,
            ...o.depth!.bids.map((l) => l[0]),
            ...o.depth!.asks.map((l) => l[0]),
            ...o.trades.map((t) => t.price),
          ]) {
            if (!onGrid(p, spec.tickSize, spec.pricePrecision)) return false;
          }
          for (const s of [
            q.bidSize,
            q.askSize,
            ...o.depth!.bids.map((l) => l[1]),
            ...o.trades.map((t) => t.qty),
          ]) {
            if (!onGrid(s, spec.qtyStep, spec.qtyPrecision)) return false;
          }
          if (!dec(q.ask).gt(dec(q.bid))) return false;
          const bids = o.depth!.bids.map((l) => dec(l[0]));
          if (bids.some((b, i) => i > 0 && !b.lt(bids[i - 1]!))) return false;
          if (o.trades.some((t) => dec(t.qty).lt(dec(spec.minQty)))) return false;
        }
        return true;
      }),
      { numRuns: 150 },
    );
  });

  it('formatPrice / floatToPrice always return registry-precision tick multiples', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TICKS),
        fc.double({ min: 1e-6, max: 1e7, noNaN: true }),
        fc.constantFrom('nearest', 'down', 'up' as const),
        ([tick, prec], x, mode) => {
          const spec = { tickSize: tick, pricePrecision: prec };
          const p = floatToPrice(x, spec, mode).toFixed(prec);
          return isOnTick(p, spec) && isOnTick(formatPrice(p, spec), spec);
        },
      ),
    );
  });

  it('quantities floor to the step and never go below min qty', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STEPS),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        ([step, min, places], x) => {
          const spec = { qtyStep: step, minQty: min, qtyPrecision: places };
          const q = floatToQty(x, spec);
          return (
            onGrid(q, step, places) &&
            dec(q).gte(dec(min)) &&
            formatQty(q, spec) === q &&
            roundQty(q, spec).eq(dec(q))
          );
        },
      ),
    );
  });

  it('every seeded registry row is internally consistent', () => {
    for (const s of SEED_INSTRUMENTS) {
      expect(() => assertPriceSpec(s)).not.toThrow();
      expect(decimalPlaces(dec(s.qtyStep).toFixed())).toBeLessThanOrEqual(s.qtyPrecision);
    }
    expect(() => assertPriceSpec({ tickSize: '0.001', pricePrecision: 2 })).toThrow(
      RegistrySpecError,
    );
    expect(() => assertPriceSpec({ tickSize: '0', pricePrecision: 2 })).toThrow(RegistrySpecError);
    expect(toPips('0.0002', { pipSize: '0.0001' })?.toFixed()).toBe('2');
    expect(formatVolume('13500.987', { qtyPrecision: 0 })).toBe('13500');
    expect(formatVolume('0.5', { qtyPrecision: 3 })).toBe('0.500');
    expect(toPips('1', { pipSize: null })).toBeNull();
    expect(() => floatToPrice(Number.NaN, { tickSize: '1', pricePrecision: 0 })).toThrow(
      RangeError,
    );
  });

  it('market data source never hard-codes a precision (no literal toFixed(<n>) / toDecimalPlaces(<n>))', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
          const src = readFileSync(p, 'utf8');
          if (/\.(toFixed|toDecimalPlaces)\(\s*\d/.test(src)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('formatPrice fast path (goal 10)', () => {
  it('gives exactly the rounded answer for every tick/precision and decimal string', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TICKS),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 8 }),
        ([tickSize, pricePrecision], digits, scale) => {
          const s = digits.toString().padStart(scale + 1, '0');
          const value = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
          const spec = { tickSize, pricePrecision };
          const slow = dec(value).toNearest(dec(tickSize), 6).toFixed(pricePrecision);
          return formatPrice(value, spec) === slow;
        },
      ),
      { numRuns: 3000 },
    );
  });
});
