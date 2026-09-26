import type { Fill } from '@kora/domain';

/**
 * SIMULATED paper fills used until the goal 03 paper engine exists (BACKLOG B-018).
 *
 * Deterministic (seeded mulberry32, integer price arithmetic in 1e-5 units): 80 round trips on
 * EURUSD and GBPUSD, 10,000 units each, stop 100 pips ($100), target 160 pips ($160), 48% hit rate,
 * $0.70 fee and $0.50 embedded slippage per fill. Not market data; not a real account.
 */
export const PAPER_FIXTURE_LABEL = 'SIMULATED fills (fixture) · the paper engine arrives in goal 03';
export const PAPER_FIXTURE_STARTING_CAPITAL = '10000';
export const PAPER_FIXTURE_TRADES = 80;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const price = (units: number) => {
  const s = String(units).padStart(6, '0');
  return `${s.slice(0, -5)}.${s.slice(-5)}`;
};

export function paperFixtureFills(seed = 20260601): Fill[] {
  const rnd = mulberry32(seed);
  const fills: Fill[] = [];
  const mid = { EURUSD: 108_000, GBPUSD: 127_000 };
  let t = Date.UTC(2026, 5, 1, 8, 0, 0);
  for (let i = 0; i < PAPER_FIXTURE_TRADES; i++) {
    const symbol = rnd() < 0.6 ? 'EURUSD' : 'GBPUSD';
    const side = rnd() < 0.5 ? 'buy' : 'sell';
    mid[symbol] += Math.round((rnd() - 0.5) * 400);
    const entry = mid[symbol];
    const win = rnd() < 0.48;
    const move = win ? 1_600 : -1_000; // in 1e-5 price units: +160 / -100 pips
    const exit = side === 'buy' ? entry + move : entry - move;
    const holdMs = (4 + Math.floor(rnd() * 16)) * 3_600_000;
    const common = { symbol, qty: '10000', fee: '0.70', slippage: '0.50' };
    fills.push({ id: `sim-f${2 * i + 1}`, orderId: `sim-o${2 * i + 1}`, side, price: price(entry), ts: new Date(t).toISOString(), ...common });
    fills.push({
      id: `sim-f${2 * i + 2}`,
      orderId: `sim-o${2 * i + 2}`,
      side: side === 'buy' ? 'sell' : 'buy',
      price: price(exit),
      ts: new Date(t + holdMs).toISOString(),
      ...common,
    });
    t += holdMs + (6 + Math.floor(rnd() * 30)) * 3_600_000;
    mid[symbol] = exit;
  }
  return fills;
}
