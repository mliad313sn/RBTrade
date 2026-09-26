import { Decimal, dec, decimalPlaces, roundToTick, type InstrumentSpec } from '@kora/domain';

/**
 * Registry-driven rounding. Every price and quantity string that leaves the market data layer
 * goes through these helpers, with tick size / precision / qty step from the instrument registry.
 * No precision is ever a literal in market data code (enforced by a source-scan test).
 */

export type PriceSpec = Pick<InstrumentSpec, 'tickSize' | 'pricePrecision'>;
export type QtySpec = Pick<InstrumentSpec, 'qtyStep' | 'qtyPrecision' | 'minQty'>;
export type RoundMode = 'nearest' | 'down' | 'up';

type Rounding = NonNullable<Parameters<typeof roundToTick>[2]>;
const ROUNDING: Record<RoundMode, Rounding> = {
  nearest: Decimal.ROUND_HALF_EVEN,
  down: Decimal.ROUND_FLOOR,
  up: Decimal.ROUND_CEIL,
};

/** Thrown when a registry row is internally inconsistent (e.g. tick finer than precision). */
export class RegistrySpecError extends Error {}

export function assertPriceSpec(spec: PriceSpec): void {
  const tick = dec(spec.tickSize);
  if (tick.lte(0)) throw new RegistrySpecError(`tick ${spec.tickSize} must be > 0`);
  if (decimalPlaces(tick.toFixed()) > spec.pricePrecision) {
    throw new RegistrySpecError(`tick ${spec.tickSize} has more decimals than precision ${spec.pricePrecision}`);
  }
}

/**
 * The single float → decimal conversion point for simulated values: the simulator's internal
 * maths is float, its outputs are ticks from the registry.
 */
export function floatToDecimal(x: number): Decimal {
  if (!Number.isFinite(x)) throw new RangeError(`non-finite value ${x}`);
  return new Decimal(x.toPrecision(15));
}

export function roundPrice(value: Decimal | string, spec: PriceSpec, mode: RoundMode = 'nearest'): Decimal {
  return roundToTick(dec(value), spec.tickSize, ROUNDING[mode]);
}

export function formatPrice(value: Decimal | string, spec: PriceSpec, mode: RoundMode = 'nearest'): string {
  return roundPrice(value, spec, mode).toFixed(spec.pricePrecision);
}

export function floatToPrice(x: number, spec: PriceSpec, mode: RoundMode = 'nearest'): Decimal {
  const r = roundPrice(floatToDecimal(x), spec, mode);
  const tick = dec(spec.tickSize);
  return r.lt(tick) ? tick : r;
}

/** Quantity floored to the qty step, never below min qty. */
export function roundQty(value: Decimal | string, spec: QtySpec): Decimal {
  const q = roundToTick(dec(value), spec.qtyStep, Decimal.ROUND_FLOOR);
  const min = dec(spec.minQty);
  return q.lt(min) ? min : q;
}

export function formatQty(value: Decimal | string, spec: QtySpec): string {
  return roundQty(value, spec).toFixed(spec.qtyPrecision);
}

/** Non-negative size (e.g. depth or volume) on the qty grid; zero allowed. */
export function formatSize(value: Decimal | string, spec: Pick<InstrumentSpec, 'qtyStep' | 'qtyPrecision'>): string {
  return roundToTick(dec(value), spec.qtyStep, Decimal.ROUND_FLOOR).toFixed(spec.qtyPrecision);
}

export function floatToQty(x: number, spec: QtySpec): string {
  return formatQty(floatToDecimal(Math.max(0, x)), spec);
}

export function isOnTick(value: string, spec: PriceSpec): boolean {
  const d = dec(value);
  return d.mod(dec(spec.tickSize)).isZero() && decimalPlaces(value) === spec.pricePrecision;
}

/** Pip value helpers for FX display (pip size from the registry). */
export function toPips(priceDiff: Decimal | string, spec: Pick<InstrumentSpec, 'pipSize'>): Decimal | null {
  if (!spec.pipSize) return null;
  return dec(priceDiff).div(dec(spec.pipSize));
}
