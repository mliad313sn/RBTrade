/** Small, dependency-free chart helpers for the SVG fan chart and histograms. */

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const s = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  s.domain = domain;
  s.range = range;
  return s;
}

/** "Nice" tick values covering [min, max] (1, 2, 2.5, 5 × 10^k steps). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(count - 1, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw / 1.5) ?? 10) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** SVG path for a polyline. */
export function linePath(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join('');
}

/** SVG path for a band between an upper and a lower series. */
export function bandPath(xs: number[], upper: number[], lower: number[]): string {
  const top = xs
    .map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${upper[i]!.toFixed(1)}`)
    .join('');
  const bottom = xs
    .map((x, i) => ({ x, y: lower[i]! }))
    .reverse()
    .map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join('');
  return `${top}${bottom}Z`;
}

/** Axis label for period k ("M0", "M6", …) with about `count` labels. */
export function periodTicks(periods: number, count = 5): number[] {
  if (periods <= 0) return [0];
  const step = Math.max(1, Math.ceil(periods / (count - 1)));
  const out: number[] = [];
  for (let k = 0; k < periods; k += step) out.push(k);
  out.push(periods);
  return out;
}
