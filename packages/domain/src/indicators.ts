/**
 * Technical indicators shared by the Pro terminal chart (goal 04) and the api's server-side alert
 * evaluator, so the chart and an RSI alert always agree.
 *
 * Indicators are display analytics, not money: they work in float64 on prices converted from the
 * registry's decimal strings for plotting only (ADR 0004 §3). Every function returns an array
 * aligned with its input, with `null` where the window is not yet full (warm-up).
 */

export interface OhlcvBar {
  /** Bucket start, epoch ms UTC. */
  t: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Series = Array<number | null>;

function assertPeriod(n: number): void {
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError(`period must be a positive integer, got ${n}`);
}

/** Simple moving average over `n` values. */
export function sma(values: readonly number[], n: number): Series {
  assertPeriod(n);
  const out: Series = new Array<number | null>(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/**
 * Exponential moving average, multiplier 2 / (n + 1), seeded with the SMA of the first `n` values
 * (the StockCharts / most-terminals convention).
 */
export function ema(values: readonly number[], n: number): Series {
  assertPeriod(n);
  const out: Series = new Array<number | null>(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i]!;
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = (values[i]! - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

export interface BollingerBands {
  middle: Series;
  upper: Series;
  lower: Series;
}

/** Bollinger bands: SMA(n) ± k · population standard deviation over the same window. */
export function bollinger(values: readonly number[], n = 20, k = 2): BollingerBands {
  assertPeriod(n);
  const middle = sma(values, n);
  const upper: Series = new Array<number | null>(values.length).fill(null);
  const lower: Series = new Array<number | null>(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    const m = middle[i]!;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (values[j]! - m) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { middle, upper, lower };
}

/**
 * Relative strength index with Wilder smoothing. The first average gain/loss is the simple mean of
 * the first `n` changes; later ones are (prev · (n − 1) + current) / n. The first value appears at
 * index `n`.
 */
export function rsi(values: readonly number[], n = 14): Series {
  assertPeriod(n);
  const out: Series = new Array<number | null>(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = rsiValue(gain, loss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = rsiValue(gain, loss);
  }
  return out;
}

function rsiValue(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** True range; the first bar has no previous close, so its range is high − low. */
export function trueRange(bars: readonly OhlcvBar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Average true range with Wilder smoothing, seeded with the mean of the first `n` true ranges. */
export function atr(bars: readonly OhlcvBar[], n = 14): Series {
  assertPeriod(n);
  const tr = trueRange(bars);
  const out: Series = new Array<number | null>(bars.length).fill(null);
  if (bars.length < n) return out;
  let prev = 0;
  for (let i = 0; i < n; i++) prev += tr[i]!;
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]!) / n;
    out[i] = prev;
  }
  return out;
}

/** Session anchor for VWAP: the UTC day by default (24/5 FX, 24/7 crypto). */
export const utcDayAnchor = (t: number): number => Math.floor(t / 86_400_000);

/**
 * Volume-weighted average price of the typical price (H + L + C) / 3, reset whenever `anchor(t)`
 * changes (a new session). Bars with no volume yet carry the previous VWAP (null at session start).
 */
export function vwapSeries(
  bars: readonly OhlcvBar[],
  anchor: (t: number) => number = utcDayAnchor,
): Series {
  const out: Series = new Array<number | null>(bars.length).fill(null);
  let session: number | null = null;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const a = anchor(b.t);
    if (a !== session) {
      session = a;
      pv = 0;
      vol = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    vol += b.volume;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export const INDICATOR_IDS = ['ema', 'sma', 'vwap', 'bollinger', 'rsi', 'atr'] as const;
export type IndicatorId = (typeof INDICATOR_IDS)[number];

/** Default periods used by the terminal (prototype legend: "EMA 20", "VWAP"). */
export const INDICATOR_DEFAULTS: Record<
  IndicatorId,
  { period: number; label: string; pane: 'price' | 'own' }
> = {
  ema: { period: 20, label: 'EMA 20', pane: 'price' },
  sma: { period: 50, label: 'SMA 50', pane: 'price' },
  vwap: { period: 0, label: 'VWAP', pane: 'price' },
  bollinger: { period: 20, label: 'BB 20, 2', pane: 'price' },
  rsi: { period: 14, label: 'RSI 14', pane: 'own' },
  atr: { period: 14, label: 'ATR 14', pane: 'own' },
};
