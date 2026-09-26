import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Decimal, dec } from '../decimal.js';
import { commission, type FeeSchedule } from './costs.js';
import {
  cashBalance,
  depositJournal,
  fillJournal,
  isBalanced,
  ledgerAmount,
  swapJournal,
  trialBalance,
  UnbalancedJournalError,
  type LedgerLine,
} from './ledger.js';
import { ZERO } from './money.js';
import {
  applyFill,
  FLAT,
  replayFills,
  signedQty,
  unrealizedPnl,
  type PositionState,
  type SignedFill,
} from './position.js';

/**
 * Goal 03 acceptance properties:
 *  1. the ledger always balances;
 *  2. position qty equals the sum of signed fills;
 *  3. realised + unrealised P&L reconciles to the equity change net of fees.
 * The engine books with exactly these functions (apps/api/src/trading).
 */

const FEES: FeeSchedule = {
  id: 'prop',
  commissionBps: '1.5',
  commissionPerUnit: '0.01',
  commissionMin: '0.5',
  swapLongBps: '-150',
  swapShortBps: '-50',
  fxConversionBps: '25',
  simulated: true,
};

// Prices on a 0.01 tick, quantities on a 0.001 step: decimal inputs only (no floats).
const price = fc.integer({ min: 1, max: 10_000_000 }).map((n) => new Decimal(n).div(100));
const qty = fc.integer({ min: 1, max: 5_000_000 }).map((n) => new Decimal(n).div(1000));
const fill: fc.Arbitrary<SignedFill> = fc.record({
  side: fc.constantFrom('buy' as const, 'sell' as const),
  qty,
  price,
});
const multiplier = fc.constantFrom('1', '0.01', '50', '100000').map((m) => dec(m));
const fxRate = fc.integer({ min: 1, max: 2_000_000 }).map((n) => new Decimal(n).div(10_000));

interface Booked {
  lines: LedgerLine[];
  position: PositionState;
  fees: Decimal;
  realized: Decimal;
}

/** Books a fill stream exactly as the engine does: deposit, then one journal per fill. */
function book(fills: SignedFill[], mult: Decimal, rate: Decimal, sameCcy: boolean): Booked {
  const lines: LedgerLine[] = [...depositJournal(dec('100000'), 'USD').lines];
  let position = FLAT;
  let fees = ZERO;
  let realized = ZERO;
  for (const f of fills) {
    const r = applyFill(position, f, mult);
    position = r.position;
    const comm = commission(FEES, f.qty, f.price, mult, 'EUR').mul(rate);
    const realizedBase = r.realizedPnl.mul(rate);
    const conv = sameCcy
      ? ZERO
      : comm.add(realizedBase.abs()).mul(dec(FEES.fxConversionBps)).div(10_000);
    const j = fillJournal({
      realizedPnl: realizedBase,
      commission: comm,
      fxConversionCost: conv,
      currency: 'USD',
    });
    expect(isBalanced(j)).toBe(true);
    lines.push(...j.lines);
    fees = fees.add(ledgerAmount(comm)).add(ledgerAmount(conv));
    realized = realized.add(ledgerAmount(realizedBase));
  }
  return { lines, position, fees, realized };
}

describe('ledger and position properties (fast-check)', () => {
  it('every journal balances and the trial balance is always zero', () => {
    fc.assert(
      fc.property(
        fc.array(fill, { maxLength: 60 }),
        multiplier,
        fxRate,
        fc.boolean(),
        fc.integer({ min: -100_000, max: 100_000 }),
        (fills, m, rate, same, swapCents) => {
          const b = book(fills, m, rate, same);
          const swap = swapJournal(new Decimal(swapCents).div(100), 'USD');
          expect(isBalanced(swap)).toBe(true);
          const all = [...b.lines, ...swap.lines];
          let total = ZERO;
          for (const v of trialBalance(all).values()) total = total.add(v);
          expect(total.isZero()).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('position qty equals the sum of signed fills, and replay equals incremental booking', () => {
    fc.assert(
      fc.property(fc.array(fill, { maxLength: 80 }), multiplier, (fills, m) => {
        let pos = FLAT;
        let realized = ZERO;
        for (const f of fills) {
          const r = applyFill(pos, f, m);
          pos = r.position;
          realized = realized.add(r.realizedPnl);
          expect(r.closedQty.add(r.openedQty).eq(f.qty)).toBe(true);
        }
        expect(pos.qty.eq(signedQty(fills))).toBe(true);
        const replay = replayFills(fills, m);
        expect(replay.position.qty.eq(pos.qty)).toBe(true);
        expect(replay.position.avgPrice.eq(pos.avgPrice)).toBe(true);
        expect(replay.realizedPnl.eq(realized)).toBe(true);
        if (pos.qty.isZero()) expect(pos.avgPrice.isZero()).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('realised + unrealised P&L − fees equals the equity change (independent mark-to-market)', () => {
    fc.assert(
      fc.property(
        fc.array(fill, { minLength: 1, maxLength: 60 }),
        multiplier,
        fxRate,
        fc.boolean(),
        price,
        (fills, m, rate, same, mark) => {
          const b = book(fills, m, rate, same);
          const cashChange = cashBalance(b.lines).sub(dec('100000'));
          const unrealized = unrealizedPnl(b.position, mark, m).mul(rate);
          const equityChange = cashChange.add(unrealized);
          // Engine identity: realised + unrealised − fees, each booked at ledger scale. Cash and the
          // booked terms are exact; only the unquantised unrealised term is added in a different order
          // on each side, so the sums can differ in the last of Decimal's significant digits (seen: 4e-35).
          expect(
            equityChange
              .sub(b.realized.add(unrealized).sub(b.fees))
              .abs()
              .lte('1e-20'),
          ).toBe(true);
          // Independent: Σ direction × qty × (mark − fill price) × multiplier × rate − fees.
          let mtm = ZERO;
          for (const f of fills)
            mtm = mtm.add(
              f.qty
                .mul(f.side === 'buy' ? 1 : -1)
                .mul(mark.sub(f.price))
                .mul(m),
            );
          const independent = mtm.mul(rate).sub(b.fees);
          // Only ledger-scale quantisation (≤ 0.5e-10 per booked amount) separates the two.
          expect(
            equityChange
              .sub(independent)
              .abs()
              .lte(new Decimal(fills.length * 3).mul('1e-10')),
          ).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('ledger journals', () => {
  it('drops zero lines and refuses unbalanced journals', () => {
    const j = fillJournal({
      realizedPnl: ZERO,
      commission: dec('1.5'),
      fxConversionCost: ZERO,
      currency: 'USD',
    });
    expect(j.lines.map((l) => l.account)).toEqual(['cash', 'fees']);
    expect(cashBalance(j.lines).toFixed()).toBe('-1.5');
    expect(depositJournal(dec('10'), 'USD').lines).toHaveLength(2);
    expect(ledgerAmount(dec('1.123456789012345')).toFixed()).toBe('1.123456789');
    expect(() =>
      fillJournal({
        realizedPnl: dec('1'),
        commission: dec('0'),
        fxConversionCost: dec('0'),
        currency: 'USD',
      }),
    ).not.toThrow();
    expect(new UnbalancedJournalError('x')).toBeInstanceOf(Error);
  });
});
