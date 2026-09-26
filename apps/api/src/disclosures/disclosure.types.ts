/**
 * Disclosures interface (goal 08 → goal 09). Callers depend only on these types and the two
 * injection tokens; goal 09's disclosures registry (per jurisdiction, Compliance-authored, with
 * approvals) replaces the config-backed implementation without touching the Novice view.
 */

export const DISCLOSURE_LOCALES = ['en', 'fr'] as const;
export type DisclosureLocale = (typeof DISCLOSURE_LOCALES)[number];

export interface DisclosureDocument {
  id: string;
  /** Published version of the text (a new version means everyone acknowledges again). */
  version: string;
  locale: DisclosureLocale;
  title: string;
  /** Short line for the persistent banner. */
  banner: string;
  /** Paragraphs shown before acknowledgement. */
  body: string[];
  /** The acknowledgement statement the user ticks. */
  acknowledge: string;
  /** Values set by Compliance, as rendered (placeholders stay visible, e.g. "[XX]"). */
  values: Record<string, string>;
  /** True while any value is still a placeholder (UI labels it). */
  placeholder: boolean;
  simulated: boolean;
  reviewStatus: string;
  /** sha256 of the rendered title, banner, body, statement and values in this locale. */
  contentHash: string;
}

export interface DisclosureRegistry {
  /** The document in force for this id and locale, or null when none is published. */
  current(id: string, locale: DisclosureLocale): DisclosureDocument | null;
}

export interface AcknowledgementRecord {
  id: string;
  disclosureId: string;
  version: string;
  contentHash: string;
  locale: DisclosureLocale;
  values: Record<string, string>;
  context: AcknowledgementContext;
  at: string;
}

export const ACK_CONTEXTS = ['onboarding', 'banner', 'settings', 'reconfirm'] as const;
export type AcknowledgementContext = (typeof ACK_CONTEXTS)[number];

export const DISCLOSURE_REGISTRY = Symbol('DISCLOSURE_REGISTRY');
