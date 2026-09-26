import { createHash } from 'node:crypto';

import { canonicalJson } from '@kora/domain';
import { z } from 'zod';

import type { DisclosureDocument, DisclosureLocale } from './disclosure.types';

/**
 * Rendering and hashing shared by every registry implementation (goal 08 config registry, goal 09
 * database registry): the same definition and values always give the same text and content hash, so
 * an acknowledgement can be re-verified years later from the stored version and values.
 */
export const LocaleTextSchema = z.strictObject({
  title: z.string().min(1).max(300),
  banner: z.string().min(1).max(1000),
  body: z.array(z.string().min(1).max(2000)).min(1).max(40),
  acknowledge: z.string().min(1).max(500),
});
export type LocaleText = z.infer<typeof LocaleTextSchema>;

export const DisclosureDefinitionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  version: z.string().min(1).max(64),
  simulated: z.boolean(),
  reviewStatus: z.string().min(1).max(64),
  values: z.array(z.string().regex(/^[a-zA-Z]{1,64}$/)),
  locales: z.strictObject({ en: LocaleTextSchema, fr: LocaleTextSchema }),
});
export type DisclosureDefinition = z.infer<typeof DisclosureDefinitionSchema>;

/** Checksum of a definition's text (published versions are immutable). */
export function definitionChecksum(def: DisclosureDefinition): string {
  return createHash('sha256').update(canonicalJson(def)).digest('hex');
}

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/** A value left unset by Compliance renders as its placeholder (`[XX]` for the retail-loss figure). */
export function placeholderFor(key: string): string {
  return key === 'retailLossPct' ? '[XX]' : `[${key}]`;
}

export function renderDisclosure(
  def: DisclosureDefinition,
  locale: DisclosureLocale,
  set: Record<string, string | null | undefined>,
  extra: { jurisdiction?: string; effectiveFrom?: string } = {},
): DisclosureDocument {
  const t = def.locales[locale];
  const values = Object.fromEntries(def.values.map((k) => [k, set[k] ?? placeholderFor(k)]));
  const placeholder = def.values.some((k) => set[k] === null || set[k] === undefined);
  const doc = {
    title: fill(t.title, values),
    banner: fill(t.banner, values),
    body: t.body.map((p) => fill(p, values)),
    acknowledge: fill(t.acknowledge, values),
  };
  const contentHash = createHash('sha256')
    .update(canonicalJson({ id: def.id, version: def.version, locale, ...doc, values }))
    .digest('hex');
  return {
    id: def.id,
    version: def.version,
    locale,
    ...doc,
    values,
    placeholder,
    simulated: def.simulated,
    reviewStatus: def.reviewStatus,
    contentHash,
    ...extra,
  };
}
