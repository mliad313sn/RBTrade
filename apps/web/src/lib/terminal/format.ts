import { dec, isDecimalString, pipSizeOf, quantize, type InstrumentSpec } from '@kora/domain';
import { formatDecimal, formatPrice } from '@kora/ui';

/** Clock time for tables: "14:03:27" in UTC or the viewer's local zone (Settings → time display). */
export function formatClock(ts: number | string, mode: 'utc' | 'local'): string {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  if (mode === 'utc') return d.toISOString().slice(11, 19);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function clockLabel(mode: 'utc' | 'local'): string {
  return mode === 'utc' ? 'UTC' : 'Local';
}

/** Quantity on the registry grid with thousands grouping ("100,000", "0.8000" → "0.8"). */
export function formatQty(qty: string, qtyPrecision: number): string {
  if (!isDecimalString(qty)) return qty;
  const d = dec(qty).abs();
  const places = Math.min(qtyPrecision, Math.max(0, (d.toFixed().split('.')[1] ?? '').length));
  return formatDecimal(d, places);
}

/** Spread in pips for instruments with a pip size, else in price units. */
export function formatSpread(
  bid: string,
  ask: string,
  spec: Pick<InstrumentSpec, 'pipSize' | 'tickSize' | 'pricePrecision'>,
): string {
  const diff = dec(ask).sub(dec(bid));
  if (spec.pipSize) return `${formatDecimal(diff.div(pipSizeOf(spec)), 1)} pip`;
  return formatDecimal(diff, spec.pricePrecision);
}

/**
 * Result line and toast after placing an order: "Order filled: buy 900,000 EURUSD at 1.08349."
 * The average fill price is a volume-weighted mean with up to 40 decimals on the wire; it is shown
 * at the instrument's price precision like every other price (IRTC R5-07).
 */
export function orderResultText(
  o: { status: string; side: string; qty: string; symbol: string; avgFillPrice?: string | null },
  precision: { qty: number; price: number },
): string {
  const at =
    o.avgFillPrice && isDecimalString(o.avgFillPrice)
      ? ` at ${formatPrice(o.avgFillPrice, precision.price)}`
      : '';
  return `Order ${o.status.replace('_', ' ')}: ${o.side} ${formatQty(o.qty, precision.qty)} ${o.symbol}${at}.`;
}

/**
 * A BCP 47 tag the Intl APIs accept, for libraries that format with the browser language (IRTC R5-18).
 * Linux browsers with a POSIX locale report "en-US@posix", which makes `toLocaleString` throw and left
 * the chart blank. Invalid tags fall back to "en-US".
 */
export function safeLocale(tag: string | undefined | null, fallback = 'en-US'): string {
  if (!tag) return fallback;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Direction of a change as displayed (IRTC R5-19): taken from the value rounded to the places shown,
 * so "0.00" gets no ▲/▼ and no colour, and a tiny negative never shows as "−0.00".
 */
export function displayDirection(value: string | number, places: number): 'up' | 'down' | 'flat' {
  const s = typeof value === 'number' ? String(value) : value;
  if (!isDecimalString(s)) return 'flat';
  const d = quantize(s, places); // the same rounding as formatDecimal / formatMoney
  return d.isZero() ? 'flat' : d.isNegative() ? 'down' : 'up';
}

/** Mid price from a quote at registry precision. */
export function midOf(bid: string, ask: string, precision: number): string {
  return dec(bid).add(dec(ask)).div(2).toDecimalPlaces(precision).toFixed(precision);
}

/** "EUR/USD" style label from the registry display name (falls back to the symbol). */
export function displayName(
  spec: Pick<InstrumentSpec, 'displayName' | 'symbol'> | null | undefined,
  symbol: string,
): string {
  return spec?.displayName || symbol;
}

/** Plays a short, quiet tone for a fill (Settings → sound on fills; off by default). */
export function playFillSound(): void {
  try {
    const Ctx = (window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => void ctx.close();
  } catch {
    /* audio unavailable */
  }
}
