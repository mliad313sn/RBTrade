import { bucketStart, type InstrumentSpec } from '@kora/domain';

import type { OhlcvBar } from '../bars.js';
import { floatToPrice, formatSize } from '../precision.js';
import { Prng } from '../prng.js';
import type { SimProfile } from '../seed/sim-profiles.js';
import { YEAR_SECONDS } from './simulated-market.js';

const MINUTE_MS = 60_000;

/**
 * Deterministic SIMULATED 1-minute history that ends exactly at `endPrice` just before `endTs`
 * (walked backwards from the live start so history and the live feed join without a jump).
 * Result is oldest first; the caller aggregates to coarser timeframes with `aggregateBars`.
 */
export function generateHistory1m(opts: {
  spec: InstrumentSpec;
  profile: SimProfile;
  seed: string | number;
  endTs: number;
  endPrice: string;
  minutes: number;
}): OhlcvBar[] {
  const { spec, profile } = opts;
  const end = bucketStart(opts.endTs, '1m');
  const rng = new Prng(`${opts.seed}|${spec.symbol}|history|${end}`);
  const sigma = profile.annualVol * Math.sqrt(60 / YEAR_SECONDS);
  const baseVol = Number(spec.minQty) * profile.depthScale * 0.05 * profile.tradeRate * 60;
  let volMult = 1;
  let close = Number(floatToPrice(Number(opts.endPrice), spec).toFixed());
  const bars: OhlcvBar[] = [];
  for (let i = 1; i <= opts.minutes; i++) {
    if (rng.next() < 0.01) volMult = [0.7, 1, 2.2][rng.int(3)]!;
    const r = volMult * sigma * rng.normal();
    const open = close * Math.exp(-r);
    const hi = Math.max(open, close) * Math.exp(Math.abs(rng.normal()) * sigma * 0.5);
    const lo = Math.min(open, close) * Math.exp(-Math.abs(rng.normal()) * sigma * 0.5);
    const o = floatToPrice(open, spec);
    const c = floatToPrice(close, spec);
    let h = floatToPrice(hi, spec, 'up');
    let l = floatToPrice(lo, spec, 'down');
    if (h.lt(o)) h = o;
    if (h.lt(c)) h = c;
    if (l.gt(o)) l = o;
    if (l.gt(c)) l = c;
    const trades = Math.max(0, Math.round(profile.tradeRate * 60 * Math.exp(0.3 * rng.normal())));
    const volume = trades === 0 ? '0' : (baseVol * Math.exp(0.4 * rng.normal())).toPrecision(12);
    bars.push({
      bucket: end - i * MINUTE_MS,
      open: o.toFixed(spec.pricePrecision),
      high: h.toFixed(spec.pricePrecision),
      low: l.toFixed(spec.pricePrecision),
      close: c.toFixed(spec.pricePrecision),
      volume: formatSize(volume, spec),
      trades,
    });
    close = Number(o.toFixed());
  }
  return bars.reverse();
}
