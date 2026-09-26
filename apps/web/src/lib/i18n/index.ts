import { en, type MessageKey } from './en';
import { fr } from './fr';

/** Novice view languages (goal 08: EN and FR from day one, B-013). */
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'kora_locale';
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', fr: 'Français' };

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, fr };

export type { MessageKey };
export type Vars = Record<string, string | number>;

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** Cookie first, then the first supported language in Accept-Language, else English. */
export function pickLocale(
  cookie: string | undefined | null,
  acceptLanguage?: string | null,
): Locale {
  if (isLocale(cookie)) return cookie;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.trim().split(';')[0]!.toLowerCase().slice(0, 2);
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}

/** `{name}` placeholders; unknown variables stay visible so a gap is noticed. */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  return interpolate(MESSAGES[locale][key] ?? MESSAGES.en[key] ?? key, vars);
}

/** True when a key exists (for keys built at runtime, e.g. `risk.${code}`). */
export function hasKey(key: string): key is MessageKey {
  return key in en;
}

export type T = (key: MessageKey, vars?: Vars) => string;

export function makeT(locale: Locale): T {
  return (key, vars) => translate(locale, key, vars);
}

/** Strips inline markup: `[text](term:id)` → text, `**b**` → b (readability, aria labels). */
export function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:term|href):[^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
}
