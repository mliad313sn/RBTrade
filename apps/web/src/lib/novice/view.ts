import { noviceLossFigures } from '@kora/domain';
import type { NoviceName, NoviceTicketResponse, RiskRejectionBody } from '@kora/sdk';

import { fmtMoney } from '../i18n/format';
import { hasKey, type Locale, type MessageKey, type T } from '../i18n';

/** Registry name in the viewer's language (the registry requires both), else the display name. */
export function assetName(
  name: NoviceName | null | undefined,
  locale: Locale,
  fallback: string,
): string {
  return name?.[locale] || name?.en || fallback;
}

/** Plain, localised text for a server risk code (goal 03 codes); unknown codes get a generic line. */
export function riskText(code: string, t: T): string {
  const key = `risk.${code}`;
  return hasKey(key) ? t(key) : t('risk.default');
}

/** Localised reasons from a 422 risk rejection or a preview verdict, without duplicates. */
export function riskReasons(violations: Array<{ code: string }> | undefined, t: T): string[] {
  return [...new Set((violations ?? []).map((v) => riskText(v.code, t)))];
}

export function isRiskRejection(body: unknown): body is RiskRejectionBody {
  return (
    !!body && typeof body === 'object' && (body as { error?: string }).error === 'risk_rejected'
  );
}

/** "since you started" wording: today, n days, 1 week, n weeks. */
export function sinceText(startedAt: string, now: number, t: T): string {
  const days = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 86_400_000));
  if (days < 1) return t('home.since.today');
  if (days < 7) return t('home.since.days', { n: days });
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? t('home.since.week') : t('home.since.weeks', { n: weeks });
}

/** Amount label: "(in dollars)" when we have a word for the currency, else the ISO code. */
export function currencyWord(ccy: string, t: T): string {
  const key = `ccy.${ccy}`;
  return hasKey(key) ? t(key as MessageKey) : ccy;
}

/**
 * What the ticket shows, formatted, straight from the preview (goal 08 acceptance: the figure
 * equals the preview's `lossIfStopHit.total`, fees included). Returns null until a preview exists.
 */
export function ticketDisplay(ticket: NoviceTicketResponse | null, locale: Locale) {
  if (!ticket || !ticket.ok) return null;
  const f = noviceLossFigures(ticket.preview.preview?.lossIfStopHit, ticket.currency);
  if (!f) return null;
  return {
    mostYouCouldLose: fmtMoney(f.mostYouCouldLose, ticket.currency, locale),
    fees: fmtMoney(f.fees, ticket.currency, locale),
    gain: fmtMoney(f.gain, ticket.currency, locale),
    raw: f,
  };
}

/** Reads a formatted money string back to a decimal string (tests: shown value == preview value). */
export function parseShownMoney(shown: string, locale: Locale): string {
  const negative = /[−-]/.test(shown);
  const body = shown.replace(/[^\d.,]/g, '');
  const normal =
    locale === 'fr' ? body.replace(/\./g, '').replace(',', '.') : body.replace(/,/g, '');
  return `${negative ? '-' : ''}${normal}`;
}
