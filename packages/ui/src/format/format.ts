import { dec, quantize, type DecimalInput } from '@kora/domain';

export type Direction = 'up' | 'down' | 'flat';

export interface FormatOptions {
  /** Show + for positive values (signed P&L, changes). */
  signed?: boolean;
  /** Thousands grouping. Default true. */
  grouping?: boolean;
}

const MINUS = '−'; // typographic minus, same width as + in tabular fonts

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Formats a decimal to exactly `decimals` places without ever touching binary floating point.
 * Rounding: half-even (banker's), same as the domain `quantize`.
 */
export function formatDecimal(
  value: DecimalInput,
  decimals: number,
  opts: FormatOptions = {},
): string {
  const d = quantize(value, decimals);
  const negative = d.isNegative() && !d.isZero();
  const [intPart, frac] = d.abs().toFixed(decimals).split('.') as [string, string | undefined];
  const body = `${opts.grouping === false ? intPart : group(intPart)}${frac !== undefined ? `.${frac}` : ''}`;
  if (negative) return `${MINUS}${body}`;
  if (opts.signed && !d.isZero()) return `+${body}`;
  return body;
}

export function direction(value: DecimalInput): Direction {
  const d = dec(value);
  if (d.isZero()) return 'flat';
  return d.isNegative() ? 'down' : 'up';
}

/** Price with instrument precision from the registry (e.g. EURUSD = 5). */
export function formatPrice(value: DecimalInput, precision: number): string {
  return formatDecimal(value, precision);
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
const CURRENCY_DECIMALS: Record<string, number> = { JPY: 0 };

export interface MoneyOptions extends FormatOptions {
  /** 'code' → "1,234.50 USD" (Pro), 'symbol' → "$1,234.50" (Novice). */
  display?: 'code' | 'symbol';
  decimals?: number;
}

export function formatMoney(
  amount: DecimalInput,
  currency: string,
  opts: MoneyOptions = {},
): string {
  const decimals = opts.decimals ?? CURRENCY_DECIMALS[currency] ?? 2;
  const s = formatDecimal(amount, decimals, opts);
  if (opts.display === 'symbol' && CURRENCY_SYMBOL[currency]) {
    const sign = s.startsWith('+') || s.startsWith(MINUS) ? s[0] : '';
    return `${sign}${CURRENCY_SYMBOL[currency]}${sign ? s.slice(1) : s}`;
  }
  return `${s} ${currency}`;
}

/** Percent from a ratio string: "0.0018" → "+0.18%". */
export function formatPercent(
  ratio: DecimalInput,
  decimals = 2,
  opts: FormatOptions = { signed: true },
): string {
  return `${formatDecimal(dec(ratio).mul(100), decimals, opts)}%`;
}

/** Plain-language direction for screen readers ("up 0.18 percent"). */
export function spokenDirection(value: DecimalInput): string {
  const dir = direction(value);
  return dir === 'flat' ? 'unchanged' : dir;
}
