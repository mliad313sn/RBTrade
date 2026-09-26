/**
 * Display formatting for simulation estimates (floats). Booked money uses formatMoney from
 * @kora/ui with Decimal; these helpers are only for statistical outputs.
 */

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 19,432 → "19.4k"; 950 → "950". */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) < 1000 ? whole.format(n) : compact.format(n).replace('K', 'k');
}

/** Whole currency amount, e.g. "$19,432". */
export function fmtMoney(n: number, currency = 'USD'): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}

/** 0.0312 → "3.1%". */
export function fmtPct(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Signed change with an arrow so colour is never the only cue: "▲ +93.7%" / "▼ −12.0%". */
export function fmtChange(
  ratio: number,
  digits = 1,
): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (!Number.isFinite(ratio) || Math.abs(ratio) < 5e-5)
    return { text: `${(0).toFixed(digits)}%`, dir: 'flat' };
  const pct = Math.abs(ratio * 100).toFixed(digits);
  return ratio > 0 ? { text: `▲ +${pct}%`, dir: 'up' } : { text: `▼ −${pct}%`, dir: 'down' };
}

/** Expectancy "+0.147 R" or "+0.12%" per trade. */
export function fmtExpectancy(value: number, unit: 'r' | 'pct'): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return unit === 'r'
    ? `${sign}${Math.abs(value).toFixed(3)} R`
    : `${sign}${Math.abs(value).toFixed(2)}%`;
}
