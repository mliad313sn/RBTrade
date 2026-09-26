import { formatDecimal, formatMoney } from '@kora/ui';

import type { Locale } from './index';

/**
 * Locale-aware display of booked money (decimal strings, never floats). English keeps the goal 01
 * `formatMoney` style ("$10,482.30", "−$214.00"); French uses a narrow no-break space for thousands,
 * a comma for decimals and the symbol after the amount ("10 482,30 $").
 */
const NNBSP = ' ';
const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'CHF' };
const DECIMALS: Record<string, number> = { JPY: 0 };

function frNumber(s: string): string {
  // "−10,482.30" → "−10 482,30" (swap separators in one pass)
  return s.replace(/[,.]/g, (c) => (c === ',' ? NNBSP : ','));
}

export function fmtMoney(
  amount: string | number,
  ccy: string,
  locale: Locale,
  opts: { signed?: boolean; decimals?: number } = {},
): string {
  const value = typeof amount === 'number' ? String(amount) : amount;
  if (!/^[-+]?\d+(\.\d+)?$/.test(value)) return '—';
  if (locale === 'en')
    return formatMoney(value, ccy, {
      display: 'symbol',
      signed: opts.signed,
      decimals: opts.decimals,
    });
  const s = formatDecimal(value, opts.decimals ?? DECIMALS[ccy] ?? 2, { signed: opts.signed });
  return `${frNumber(s)}${NNBSP}${SYMBOLS[ccy] ?? ccy}`;
}

/** Decimal-string percentage as shown ("4.82" → "4.82" / "4,82"), optionally signed. */
export function fmtPctNumber(
  pct: string,
  locale: Locale,
  opts: { signed?: boolean; decimals?: number } = {},
): string {
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- linear pattern (no nested quantifiers), reviewed goal 10
  if (!/^[-+]?\d+(\.\d+)?$/.test(pct)) return '—';
  const s = formatDecimal(pct, opts.decimals ?? 1, { signed: opts.signed });
  return locale === 'fr' ? frNumber(s) : s;
}

/** Plain decimal ("2" → "2", "1.5" → "1,5" in French). */
export function fmtNumber(n: string | number, locale: Locale): string {
  const s = String(n);
  return locale === 'fr' ? s.replace('.', ',') : s;
}

const TAG: Record<Locale, string> = { en: 'en-GB', fr: 'fr-FR' };

/** "Mon 28 Sep, 14:00" in the viewer's time zone. */
export function fmtDateTime(iso: string, locale: Locale, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(TAG[locale], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

export function fmtDate(iso: string, locale: Locale, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(TAG[locale], {
    day: 'numeric',
    month: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

export function fmtTime(iso: string, locale: Locale, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(TAG[locale], {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}
