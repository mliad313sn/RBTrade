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
  /** Goal 09 registry: jurisdiction of this version (`GLOBAL` or ISO 3166 alpha-2) and when it took effect. */
  jurisdiction?: string;
  effectiveFrom?: string;
}

export interface DisclosureRegistry {
  /** The document in force for this id and locale, or null when none is published. */
  current(id: string, locale: DisclosureLocale): DisclosureDocument | null;
  /**
   * Goal 09 (optional): the exact document of a stored version rendered with the stored values, to
   * show and re-verify what a user acknowledged. Null when the version is unknown.
   */
  render?(
    id: string,
    version: string,
    jurisdiction: string,
    locale: DisclosureLocale,
    values: Record<string, string>,
  ): DisclosureDocument | null;
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
  jurisdiction?: string;
}

export const ACK_CONTEXTS = ['onboarding', 'banner', 'settings', 'reconfirm'] as const;
export type AcknowledgementContext = (typeof ACK_CONTEXTS)[number];

export const DISCLOSURE_REGISTRY = Symbol('DISCLOSURE_REGISTRY');

/** The risk warning a novice acknowledges before the first order (goal 08 onboarding, B-801 gate). */
export const RISK_WARNING_DISCLOSURE_ID = 'risk-warning';
