import { createHash } from 'node:crypto';

import { DepthSnapshotSchema, QuoteSchema, TradeSchema } from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { SEED_INSTRUMENTS } from '../seed/instruments.js';
import { simProfileFor } from '../seed/sim-profiles.js';
import {
  isAffected,
  SimulatedMarket,
  type EventShock,
  type SimInstrument,
  type SimStep,
} from './simulated-market.js';

const START = Date.parse('2026-09-25T10:00:00Z');
const SYMBOLS = ['EURUSD', 'XAUUSD', 'BTCUSD', '7203.XTKS'];
const SHOCKS: EventShock[] = [
  { id: 'us-cpi', ts: START + 50_000, country: 'US', currency: 'USD', impact: 3 },
];

function instruments(): SimInstrument[] {
  return SYMBOLS.map((s) => {
    const spec = SEED_INSTRUMENTS.find((i) => i.symbol === s)!;
    return { spec, profile: simProfileFor(spec), countries: [] };
  });
}

function run(seed: string | number, steps: number): SimStep[] {
  const m = new SimulatedMarket({
    seed,
    startTs: START,
    instruments: instruments(),
    shocks: SHOCKS,
  });
  return Array.from({ length: steps }, () => m.step());
}

const digest = (steps: SimStep[]) =>
  createHash('sha256').update(JSON.stringify(steps)).digest('hex');

describe('SimulatedMarket determinism (acceptance: same seed → identical sequence)', () => {
  it('matches the committed snapshot for seed 42 (2 000 steps × 4 instruments)', () => {
    const steps = run(42, 2000);
    const counts = { quotes: 0, trades: 0, depth: 0 };
    for (const s of steps)
      for (const o of s.outputs) {
        counts.quotes += o.quote ? 1 : 0;
        counts.depth += o.depth ? 1 : 0;
        counts.trades += o.trades.length;
      }
    expect({
      digest: digest(steps),
      counts,
      first: steps[0]!.outputs.map((o) => o.quote),
      last: steps.at(-1)!.outputs.map((o) => ({ quote: o.quote, regime: o.regime })),
    }).toMatchSnapshot();
  });

  it('two runs with the same seed are identical; a different seed differs', () => {
    expect(digest(run('kora', 500))).toBe(digest(run('kora', 500)));
    expect(digest(run('kora', 500))).not.toBe(digest(run('kora-2', 500)));
  });

  it('per-symbol streams are independent of the instrument set', () => {
    const spec = SEED_INSTRUMENTS.find((i) => i.symbol === 'EURUSD')!;
    const alone = new SimulatedMarket({
      seed: 7,
      startTs: START,
      instruments: [{ spec, profile: simProfileFor(spec) }],
    });
    const all = new SimulatedMarket({ seed: 7, startTs: START, instruments: instruments() });
    for (let i = 0; i < 200; i++) {
      const a = alone.step().outputs[0]!;
      const b = all.step().outputs.find((o) => o.symbol === 'EURUSD')!;
      expect(a).toEqual(b);
    }
  });

  it('emits schema-valid messages with contiguous seq and virtual timestamps', () => {
    const steps = run(1, 300);
    const lastSeq = new Map<string, number>();
    for (const s of steps) {
      for (const o of s.outputs) {
        expect(QuoteSchema.safeParse(o.quote).success).toBe(true);
        expect(DepthSnapshotSchema.safeParse(o.depth).success).toBe(true);
        for (const t of o.trades) expect(TradeSchema.safeParse(t).success).toBe(true);
        expect(o.quote!.exchangeTs).toBe(START + s.step * 100);
        const prev = lastSeq.get(o.symbol) ?? 0;
        expect(o.quote!.seq).toBe(prev + 1);
        lastSeq.set(o.symbol, o.quote!.seq);
      }
    }
  });

  it('event shocks switch affected instruments to high-vol and leave others alone', () => {
    const m = new SimulatedMarket({
      seed: 3,
      startTs: START,
      instruments: instruments(),
      shocks: SHOCKS,
    });
    for (let i = 0; i < 500; i++) m.step();
    expect(m.regime('EURUSD')).toBe('high_vol');
    expect(m.regime('XAUUSD')).toBe('high_vol');
    expect(m.regime('BTCUSD')).toBe('high_vol');
    const toyota = instruments()[3]!;
    expect(isAffected(toyota, SHOCKS[0]!)).toBe(false);
    expect(isAffected({ ...toyota, countries: ['JP'] }, { country: 'JP', currency: 'JPY' })).toBe(
      true,
    );
    expect(m.lastQuote('NOPE')).toBeNull();
    expect(m.lastDepth('NOPE')).toBeNull();
    expect(m.regime('NOPE')).toBeNull();
    m.addShocks([
      { ...SHOCKS[0]!, ts: START + 60_000 },
      { id: 'x', ts: START + 70_000, country: 'GB', currency: 'GBP', impact: 1 },
    ]);
    expect(m.symbols()).toEqual(SYMBOLS);
  });

  it('funds quote rarely (quoteEveryNSteps from the profile)', () => {
    const spec = SEED_INSTRUMENTS.find((i) => i.assetClass === 'fund')!;
    const m = new SimulatedMarket({
      seed: 1,
      startTs: START,
      instruments: [{ spec, profile: simProfileFor(spec) }],
    });
    let quotes = 0;
    for (let i = 0; i < 1200; i++) quotes += m.step().outputs[0]!.quote ? 1 : 0;
    expect(quotes).toBe(2);
  });
});
