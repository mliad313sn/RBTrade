import { Decimal, dec, type DecimalInput } from '../decimal.js';

/**
 * Currency minor units (ISO 4217 exponents) for display and for charging fees. Ledger amounts stay
 * exact; only charges (commission, swap, conversion fee) are rounded to the minor unit.
 */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  CLP: 0,
  ISK: 0,
  VND: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  BTC: 8,
  ETH: 8,
};

export const CURRENCY_RE = /^[A-Z]{3}$/;

export function currencyDecimals(ccy: string): number {
  return MINOR_UNITS[ccy] ?? 2;
}

/** Round to the currency's minor unit, banker's rounding. */
export function roundMoney(value: DecimalInput, ccy: string): Decimal {
  return dec(value).toDecimalPlaces(currencyDecimals(ccy), Decimal.ROUND_HALF_EVEN);
}

export function formatAmount(value: DecimalInput, ccy: string): string {
  return roundMoney(value, ccy).toFixed(currencyDecimals(ccy));
}

/** Percentage with two decimals, e.g. 0.2043 → "0.20". */
export function formatPct(ratio: DecimalInput): string {
  return dec(ratio).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
}

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

export function sum(values: Iterable<Decimal>): Decimal {
  let s = ZERO;
  for (const v of values) s = s.add(v);
  return s;
}
