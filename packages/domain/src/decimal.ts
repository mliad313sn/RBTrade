import { Decimal as DecimalJs } from 'decimal.js';

/**
 * KORA decimal type. Money, prices and quantities are always Decimal (never JS number).
 * A dedicated clone keeps global decimal.js settings untouched for other consumers.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -30,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;

export type DecimalInput = string | bigint | Decimal;

/** Canonical decimal string grammar accepted from users and over the wire. */
export const DECIMAL_STRING = /^[+-]?(?:\d+)(?:\.\d+)?$/;

export class DecimalParseError extends Error {
  constructor(input: unknown) {
    super(`Not a valid decimal: ${String(input)}`);
    this.name = 'DecimalParseError';
  }
}

/**
 * Build a Decimal from a string, bigint or Decimal. JS numbers are rejected on purpose unless they
 * are safe integers, so binary floating point can never leak into money maths.
 */
export function dec(input: DecimalInput | number): Decimal {
  if (input instanceof Decimal) return input;
  if (typeof input === 'bigint') return new Decimal(input.toString());
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) throw new DecimalParseError(input);
    return new Decimal(input);
  }
  const s = input.trim();
  if (!DECIMAL_STRING.test(s)) throw new DecimalParseError(input);
  return new Decimal(s);
}

export function isDecimalString(s: string): boolean {
  return DECIMAL_STRING.test(s.trim());
}

/** Quantise to a number of decimal places (instrument precision), banker's rounding by default. */
export function quantize(
  value: DecimalInput,
  decimals: number,
  rounding: DecimalJs.Rounding = Decimal.ROUND_HALF_EVEN,
): Decimal {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals must be an integer in [0, 18], got ${decimals}`);
  }
  return dec(value).toDecimalPlaces(decimals, rounding);
}

/** Round to a tick size, e.g. 0.00001 or 0.25. Tick must be > 0. */
export function roundToTick(
  value: DecimalInput,
  tick: DecimalInput,
  rounding: DecimalJs.Rounding = Decimal.ROUND_HALF_EVEN,
): Decimal {
  const t = dec(tick);
  if (t.lte(0)) throw new RangeError('tick must be > 0');
  return dec(value).div(t).toDecimalPlaces(0, rounding).mul(t);
}

/** Count decimal places in a canonical decimal string ("1.0842" -> 4). */
export function decimalPlaces(s: string): number {
  if (!isDecimalString(s)) throw new DecimalParseError(s);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}
