import { dec, Decimal, quantize } from './decimal.js';

/**
 * Portfolio risk analytics for the Pro terminal's Risk tab (goal 04): net exposure by currency,
 * historical VaR, return correlations and correlation clusters.
 *
 * Exposure is Decimal (money). VaR and correlations are statistical estimates computed in float64
 * from historical closes and labelled as estimates in the UI; the VaR amount is converted back to
 * a Decimal string at the account currency's 2 dp.
 */

export interface ExposurePosition {
  symbol: string;
  /** Signed quantity (negative = short). */
  qty: string;
  /** Mark price in the quote currency. */
  price: string;
  multiplier: string;
  /** FX-like instruments (fx, metals, crypto pairs) expose their base currency too. */
  baseCcy: string | null;
  quoteCcy: string;
}

export interface CurrencyExposure {
  currency: string;
  /** Net amount in that currency (positive = long the currency). */
  amount: string;
  /** Same amount in the account currency, null when no FX rate is available. */
  amountBase: string | null;
}

/**
 * Net exposure by currency. A long EUR/USD position is long EUR (qty × multiplier) and short USD
 * (qty × multiplier × price); a long AAPL position is long its quote currency USD by its notional.
 */
export function netExposureByCurrency(
  positions: readonly ExposurePosition[],
  toBase: (ccy: string) => Decimal | null,
): CurrencyExposure[] {
  const net = new Map<string, Decimal>();
  const add = (ccy: string, v: Decimal) => net.set(ccy, (net.get(ccy) ?? new Decimal(0)).add(v));
  for (const p of positions) {
    const units = dec(p.qty).mul(dec(p.multiplier));
    const notional = units.mul(dec(p.price));
    if (p.baseCcy && p.baseCcy !== p.quoteCcy) {
      add(p.baseCcy, units);
      add(p.quoteCcy, notional.neg());
    } else {
      add(p.quoteCcy, notional);
    }
  }
  return [...net.entries()]
    .filter(([, v]) => !v.isZero())
    .map(([currency, v]) => {
      const rate = toBase(currency);
      return { currency, amount: quantize(v, 8).toFixed(), amountBase: rate ? quantize(v.mul(rate), 2).toFixed(2) : null };
    })
    .sort((a, b) => Math.abs(Number(b.amountBase ?? 0)) - Math.abs(Number(a.amountBase ?? 0)) || a.currency.localeCompare(b.currency));
}

/** Simple returns from a close series (float64 estimates). */
export function simpleReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev > 0) out.push(closes[i]! / prev - 1);
  }
  return out;
}

/**
 * Empirical quantile with linear interpolation between order statistics (Hyndman–Fan type 7,
 * the default in numpy and Excel's PERCENTILE.INC).
 */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new RangeError('quantile of an empty series');
  if (q < 0 || q > 1) throw new RangeError('q must be in [0, 1]');
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

export const VAR_MIN_OBSERVATIONS = 20;

export interface HistoricalVarInput {
  /** Current value of each position in the account currency (signed: shorts negative). */
  positions: Array<{ symbol: string; valueBase: number }>;
  /** Daily simple returns per symbol, aligned by date (most recent last). */
  returns: Record<string, number[]>;
  confidence?: number;
  maxObservations?: number;
}

export interface HistoricalVarResult {
  method: 'historical';
  confidence: number;
  horizonDays: 1;
  /** Loss not exceeded with `confidence` probability over one day; null when history is short. */
  value: string | null;
  observations: number;
  required: number;
}

/**
 * One-day historical VaR by full revaluation of today's positions on the last N aligned daily
 * returns: P&L_t = Σ value_i · r_i,t; VaR = −quantile(P&L, 1 − confidence), floored at zero.
 */
export function historicalVar(i: HistoricalVarInput): HistoricalVarResult {
  const confidence = i.confidence ?? 0.95;
  const maxObs = i.maxObservations ?? 250;
  const held = i.positions.filter((p) => p.valueBase !== 0);
  const base = { method: 'historical' as const, confidence, horizonDays: 1 as const, required: VAR_MIN_OBSERVATIONS };
  if (held.length === 0) return { ...base, value: '0.00', observations: 0 };
  const n = Math.min(maxObs, ...held.map((p) => i.returns[p.symbol]?.length ?? 0));
  if (n < VAR_MIN_OBSERVATIONS) return { ...base, value: null, observations: n };
  const pnl: number[] = [];
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (const p of held) {
      const r = i.returns[p.symbol]!;
      s += p.valueBase * r[r.length - n + t]!;
    }
    pnl.push(s);
  }
  const v = Math.max(0, -quantile(pnl, 1 - confidence));
  return { ...base, value: v.toFixed(2), observations: n };
}

/** Pearson correlation of two equally long series; null when either is constant or too short. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(a.length - n);
  const y = b.slice(b.length - n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < n; k++) {
    const dx = x[k]! - mx;
    const dy = y[k]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

export interface CorrelationResult {
  symbols: string[];
  /** Row-major, rounded to 2 dp; null where undefined. */
  matrix: Array<Array<number | null>>;
  /** Groups of ≥ 2 symbols linked by |ρ| ≥ threshold (single linkage). */
  clusters: string[][];
  threshold: number;
}

export function correlationClusters(returns: Record<string, number[]>, threshold = 0.7): CorrelationResult {
  const symbols = Object.keys(returns).sort();
  const matrix = symbols.map((a) =>
    symbols.map((b) => {
      if (a === b) return 1;
      const r = pearson(returns[a]!, returns[b]!);
      return r === null ? null : Math.round(r * 100) / 100;
    }),
  );
  const parent = symbols.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const r = matrix[i]![j];
      if (r !== null && r !== undefined && Math.abs(r) >= threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, string[]>();
  symbols.forEach((s, k) => {
    const root = find(k);
    groups.set(root, [...(groups.get(root) ?? []), s]);
  });
  const clusters = [...groups.values()].filter((g) => g.length > 1);
  return { symbols, matrix, clusters, threshold };
}
