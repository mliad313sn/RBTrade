'use client';

import { dec, isDecimalString, quantize } from '@kora/domain';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';

import { cx } from '../lib/cx';
import { describedBy, Field, type FieldProps } from './Input';

export interface NumberInputProps
  extends Omit<
      InputHTMLAttributes<HTMLInputElement>,
      'value' | 'onChange' | 'type' | 'min' | 'max' | 'step' | 'size'
    >,
    FieldProps {
  /** Decimal string. Never a JS number. */
  value: string;
  onValueChange: (value: string) => void;
  /** Max decimal places (instrument precision). */
  precision: number;
  min?: string;
  max?: string;
  /** Step for ArrowUp/ArrowDown, as a decimal string (e.g. tick size). */
  step?: string;
  allowNegative?: boolean;
  /**
   * Language for separators (IRTC R5-08). Defaults to the nearest `lang` attribute (the Novice view
   * sets `<html lang="fr">` for French), else English.
   */
  locale?: string;
}

/** Characters a user may type while editing (partial decimals like "1." or "-" are allowed). */
export function isPartialDecimal(s: string, precision: number, allowNegative: boolean): boolean {
  const sign = allowNegative ? '-?' : '';
  const frac = precision > 0 ? `(\\.\\d{0,${precision}})?` : '';
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- linear pattern (no nested quantifiers), reviewed goal 10
  return new RegExp(`^${sign}\\d*${frac}$`).test(s);
}

function clamp(v: string, min?: string, max?: string): string {
  let d = dec(v);
  if (min !== undefined && d.lt(dec(min))) d = dec(min);
  if (max !== undefined && d.gt(dec(max))) d = dec(max);
  return d.toString();
}

/** Normalises a finished value to exactly `precision` places, within [min, max]. */
export function normaliseDecimal(
  raw: string,
  precision: number,
  min?: string,
  max?: string,
): string {
  const s = raw.trim();
  if (s === '' || s === '-' || s === '.' || s === '-.') return '';
  const fixed = s.endsWith('.')
    ? s.slice(0, -1)
    : s.startsWith('.')
      ? `0${s}`
      : s.replace(/^-\./, '-0.');
  if (!isDecimalString(fixed)) return '';
  return quantize(clamp(fixed, min, max), precision).toFixed(precision);
}

/** Decimal separator of a language: a comma for French (and most of continental Europe), else a point. */
export function decimalSeparator(locale: string | undefined): ',' | '.' {
  const l = (locale ?? 'en').toLowerCase();
  return /^(fr|de|es|it|pt|nl|pl|ru|tr|sv|da|fi|nb|no|cs|sk|hu|ro)\b/.test(l) ? ',' : '.';
}

export type LocaleParse =
  | { ok: true; canonical: string }
  | { ok: false; reason: 'ambiguous' | 'invalid' };

/**
 * Reads what a person typed or pasted as a canonical decimal string ("2500.5"), per language (IRTC R5-08).
 *
 * - English: `.` is the decimal point; `,` only groups thousands ("2,500" → 2500). A comma that does
 *   not sit between groups of three digits ("2,5", "2,50") is ambiguous and refused with a message,
 *   never silently read as a decimal point ("2,500" used to become 2.50).
 * - Comma languages (French): `,` is the decimal comma; spaces, no-break spaces and `.` between groups
 *   of three digits group thousands ("2 500,5", "2.500,5" → 2500.5); a lone `.` is accepted as a decimal
 *   point (numeric keypads).
 */
export function parseLocaleDecimal(raw: string, locale: string | undefined): LocaleParse {
  const s = raw.trim().replace(/[\s\u00a0\u202f]/g, '');
  if (s === '') return { ok: true, canonical: '' };
  if (!/^-?[\d.,]*$/.test(s)) return { ok: false, reason: 'invalid' };
  const neg = s.startsWith('-') ? '-' : '';
  const body = neg ? s.slice(1) : s;
  if (decimalSeparator(locale) === '.') {
    const [int = '', ...rest] = body.split('.');
    if (rest.length > 1 || rest.some((r) => r.includes(',')))
      return { ok: false, reason: 'invalid' };
    if (!int.includes(',')) return { ok: true, canonical: `${neg}${body}` };
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- linear pattern, bounded groups
    if (!/^\d{1,3}(,\d{3})+$/.test(int)) return { ok: false, reason: 'ambiguous' };
    return {
      ok: true,
      canonical: `${neg}${int.replace(/,/g, '')}${rest.length ? `.${rest[0]}` : ''}`,
    };
  }
  const commas = body.split(',').length - 1;
  if (commas > 1) return { ok: false, reason: 'invalid' };
  if (commas === 1) {
    const [int = '', frac = ''] = body.split(',');
    if (int.includes('.')) {
      // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- linear pattern, bounded groups
      if (!/^\d{1,3}(\.\d{3})+$/.test(int)) return { ok: false, reason: 'ambiguous' };
      return { ok: true, canonical: `${neg}${int.replace(/\./g, '')}.${frac}` };
    }
    return { ok: true, canonical: `${neg}${int}.${frac}` };
  }
  if (body.split('.').length > 2) {
    // "2.500.000": dots as thousands groups.
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- linear pattern, bounded groups
    if (/^\d{1,3}(\.\d{3})+$/.test(body))
      return { ok: true, canonical: `${neg}${body.replace(/\./g, '')}` };
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, canonical: `${neg}${body}` };
}

/** A canonical decimal shown with the language's decimal separator (no grouping while editing). */
export function formatForInput(value: string, locale: string | undefined): string {
  return decimalSeparator(locale) === ',' ? value.replace('.', ',') : value;
}

const AMBIGUOUS: Record<',' | '.', string> = {
  '.': 'Use a comma only between thousands (2,500) and a point for decimals (2.5).',
  ',': 'Utilisez une virgule pour les décimales (2,5) et des espaces entre les milliers (2 500).',
};

/**
 * Decimal-safe numeric input: keeps a string, validates against instrument precision, steps with
 * Decimal maths. There is no parseFloat anywhere in this component. Separators follow the language
 * (IRTC R5-08): the text typed is kept while editing, the value passed up is always canonical.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    label,
    hint,
    error,
    hideLabel,
    id,
    value,
    onValueChange,
    precision,
    min,
    max,
    step,
    allowNegative = false,
    locale,
    className,
    onBlur,
    onFocus,
    onKeyDown,
    ...rest
  },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLInputElement, []);
  const [lang, setLang] = useState<string | undefined>(locale);
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sep = decimalSeparator(locale ?? lang);

  const detect = () =>
    locale ?? inner.current?.closest('[lang]')?.getAttribute('lang') ?? undefined;
  useEffect(() => {
    setLang(detect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  // While editing, keep the person's text unless the value was changed from outside (a draft prefill).
  const textValue = text !== null ? parseLocaleDecimal(text, locale ?? lang) : null;
  // IRTC re-verify R5-08: an ambiguous text ("2," on the way to "2,500") holds no value; it must stay
  // on screen, otherwise the next keystrokes start from an empty field and "2,500" becomes "500".
  const inSync =
    text !== null &&
    (problem !== null ||
      (textValue?.ok === true && textValue.canonical === value) ||
      (textValue?.ok === false && value === ''));
  const shown = inSync ? text : formatForInput(value, locale ?? lang);

  const stepBy = (dir: 1 | -1, e: KeyboardEvent<HTMLInputElement>) => {
    if (!step) return;
    e.preventDefault();
    const base = isDecimalString(value) ? value : (min ?? '0');
    const next = dec(base).plus(dec(step).mul(dir));
    if (!allowNegative && next.isNegative()) return;
    const n = normaliseDecimal(next.toString(), precision, min, max);
    setText(null);
    setProblem(null);
    onValueChange(n);
  };

  return (
    <Field id={inputId} label={label} hint={hint} error={error ?? problem} hideLabel={hideLabel}>
      <input
        ref={inner}
        id={inputId}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className={cx('k-input', 'k-input--num', className)}
        aria-invalid={error || problem ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error ?? problem)}
        value={shown}
        onFocus={(e) => {
          setLang(detect());
          onFocus?.(e);
        }}
        onChange={(e) => {
          const raw = e.target.value;
          const parsed = parseLocaleDecimal(raw, detect());
          if (!parsed.ok) {
            if (parsed.reason === 'invalid') return; // refuse the keystroke, as before
            // Ambiguous so far ("2,5" may become "2,500"): keep the text, hold no value until it is clear.
            setText(raw);
            if (value !== '') onValueChange('');
            return;
          }
          if (!isPartialDecimal(parsed.canonical, precision, allowNegative)) return;
          setText(raw);
          setProblem(null);
          onValueChange(parsed.canonical);
        }}
        onBlur={(e) => {
          const current = text ?? formatForInput(value, locale ?? lang);
          const parsed = parseLocaleDecimal(current, detect());
          if (!parsed.ok) {
            setProblem(AMBIGUOUS[sep]);
            if (value !== '') onValueChange('');
          } else {
            const n = normaliseDecimal(parsed.canonical, precision, min, max);
            setText(null);
            setProblem(null);
            if (n !== value) onValueChange(n);
          }
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') stepBy(1, e);
          else if (e.key === 'ArrowDown') stepBy(-1, e);
          onKeyDown?.(e);
        }}
        {...rest}
      />
    </Field>
  );
});
