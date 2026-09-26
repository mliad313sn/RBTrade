import { atr, ema, rsi, type OhlcvBar } from '@kora/domain';

/**
 * The terminal strip's bias rule: a transparent, data-only score (no model text). Its confidence is
 * never this score itself: the strip shows the calibrated hit rate of past scores in the same bin
 * (`bias:<symbol>:<tf>` in the calibration table), replayed over history net of the spread.
 *
 * z = 0.8 × (EMA20 − EMA50) / ATR14 + 0.4 × (close − close[−4]) / ATR14 + 0.6 × (RSI14 − 50) / 50
 * score = 1 / (1 + e^(−z))   (probability-like; > 0.5 leans long)
 */
export const BIAS_WEIGHTS = { emaSpread: 0.8, momentum: 0.4, rsi: 0.6 } as const;
export const BIAS_HORIZON_BARS = 4;
export const BIAS_WARMUP = 55;

export interface BiasDriver {
  key: 'emaSpread' | 'momentum' | 'rsi';
  label: string;
  /** Feature value (unitless: ATR multiples or scaled RSI), 4 decimals. */
  value: number;
  /** Signed contribution to z, 4 decimals. */
  contribution: number;
}

export interface BiasPoint {
  score: number;
  direction: 'long' | 'short' | 'neutral';
  label: string;
  /** Confidence in the stated direction's bin key: max(score, 1 − score). */
  directionalScore: number;
  drivers: BiasDriver[];
  inputs: { ema20: number; ema50: number; atr14: number; rsi14: number; close: number };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function biasLabel(score: number): { direction: BiasPoint['direction']; label: string } {
  if (score >= 0.62) return { direction: 'long', label: 'Long bias' };
  if (score >= 0.55) return { direction: 'long', label: 'Mild long bias' };
  if (score <= 0.38) return { direction: 'short', label: 'Short bias' };
  if (score <= 0.45) return { direction: 'short', label: 'Mild short bias' };
  return { direction: 'neutral', label: 'No clear bias' };
}

/** Bias at every bar (null during warm-up). Point-in-time: bar t only uses bars ≤ t. */
export function biasSeries(bars: readonly OhlcvBar[]): Array<BiasPoint | null> {
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const a14 = atr(bars, 14);
  const r14 = rsi(closes, 14);
  return bars.map((b, t) => {
    const E20 = e20[t];
    const E50 = e50[t];
    const A = a14[t];
    const R = r14[t];
    if (
      t < BIAS_WARMUP ||
      E20 === null ||
      E50 === null ||
      A === null ||
      R === null ||
      E20 === undefined ||
      E50 === undefined ||
      A === undefined ||
      R === undefined ||
      A <= 0
    )
      return null;
    const emaSpread = (E20 - E50) / A;
    const momentum = (b.close - closes[t - 4]!) / A;
    const rsiC = (R - 50) / 50;
    const drivers: BiasDriver[] = [
      {
        key: 'emaSpread',
        label: 'EMA 20 vs EMA 50 (ATR multiples)',
        value: r4(emaSpread),
        contribution: r4(BIAS_WEIGHTS.emaSpread * emaSpread),
      },
      {
        key: 'momentum',
        label: '4-bar momentum (ATR multiples)',
        value: r4(momentum),
        contribution: r4(BIAS_WEIGHTS.momentum * momentum),
      },
      {
        key: 'rsi',
        label: 'RSI 14 vs 50',
        value: r4(rsiC),
        contribution: r4(BIAS_WEIGHTS.rsi * rsiC),
      },
    ];
    const z = drivers.reduce((s, d) => s + d.contribution, 0);
    const score = r4(1 / (1 + Math.exp(-z)));
    const { direction, label } = biasLabel(score);
    return {
      score,
      direction,
      label,
      directionalScore: r4(Math.max(score, 1 - score)),
      drivers: [...drivers].sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution)),
      inputs: { ema20: r6(E20), ema50: r6(E50), atr14: r6(A), rsi14: r4(R), close: b.close },
    };
  });
}

export interface BiasReplayRow {
  t: number;
  predicted: number;
  outcome: boolean;
  netReturn: number;
}

/**
 * Replays the rule over history: at each bar with a directional bias, did the price move in that
 * direction by more than the round-trip cost within `BIAS_HORIZON_BARS`? Net return is in ATR units
 * after cost. Used to fill the calibration table; outcomes are only known for bars with a full horizon.
 */
export function replayBias(bars: readonly OhlcvBar[], costPrice: number): BiasReplayRow[] {
  const series = biasSeries(bars);
  const out: BiasReplayRow[] = [];
  for (let t = 0; t + BIAS_HORIZON_BARS < bars.length; t++) {
    const p = series[t];
    if (!p || p.direction === 'neutral') continue;
    const dir = p.direction === 'long' ? 1 : -1;
    const move = (bars[t + BIAS_HORIZON_BARS]!.close - bars[t]!.close) * dir - costPrice;
    out.push({
      t: bars[t]!.t,
      predicted: p.directionalScore,
      outcome: move > 0,
      netReturn: r6(move / p.inputs.atr14),
    });
  }
  return out;
}
