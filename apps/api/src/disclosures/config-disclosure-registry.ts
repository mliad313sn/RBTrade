import { createHash } from 'node:crypto';

import { canonicalJson } from '@kora/domain';
import { z } from 'zod';

import type { DisclosureDocument, DisclosureLocale, DisclosureRegistry } from './disclosure.types';
import riskWarningV1 from './risk-warning.v1.json';

const LocaleText = z.strictObject({
  title: z.string().min(1),
  banner: z.string().min(1),
  body: z.array(z.string().min(1)).min(1),
  acknowledge: z.string().min(1),
});

const DefinitionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  version: z.string().min(1).max(64),
  simulated: z.boolean(),
  reviewStatus: z.string().min(1),
  values: z.array(z.string().regex(/^[a-zA-Z]+$/)),
  locales: z.strictObject({ en: LocaleText, fr: LocaleText }),
});
type Definition = z.infer<typeof DefinitionSchema>;

/** The regulatory retail-loss figure: set by Compliance (OQ-R1); the placeholder stays visible. */
export const RETAIL_LOSS_PLACEHOLDER = '[XX]';

export function retailLossPct(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.KORA_DISCLOSURE_RETAIL_LOSS_PCT?.trim();
  if (!raw) return null;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(raw) || Number(raw) > 100)
    throw new Error('KORA_DISCLOSURE_RETAIL_LOSS_PCT must be a percentage such as 74 or 74.5');
  return raw;
}

const render = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/**
 * Config-backed registry (goal 08): versioned JSON documents in EN and FR plus values from env.
 * Goal 09 replaces this with the Compliance-owned registry (per jurisdiction, with approvals).
 */
export class ConfigDisclosureRegistry implements DisclosureRegistry {
  private readonly defs = new Map<string, Definition>();
  private readonly values: Record<string, string>;
  private readonly placeholder: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env, files: unknown[] = [riskWarningV1]) {
    for (const raw of files) {
      const d = DefinitionSchema.parse(raw);
      const cur = this.defs.get(d.id);
      if (!cur || Number(cur.version) < Number(d.version)) this.defs.set(d.id, d);
    }
    const pct = retailLossPct(env);
    this.values = { retailLossPct: pct ?? RETAIL_LOSS_PLACEHOLDER };
    this.placeholder = pct === null;
  }

  current(id: string, locale: DisclosureLocale): DisclosureDocument | null {
    const d = this.defs.get(id);
    if (!d) return null;
    const t = d.locales[locale];
    const values = Object.fromEntries(d.values.map((k) => [k, this.values[k] ?? `[${k}]`]));
    const doc = {
      title: render(t.title, values),
      banner: render(t.banner, values),
      body: t.body.map((p) => render(p, values)),
      acknowledge: render(t.acknowledge, values),
    };
    const contentHash = createHash('sha256')
      .update(canonicalJson({ id: d.id, version: d.version, locale, ...doc, values }))
      .digest('hex');
    return {
      id: d.id,
      version: d.version,
      locale,
      ...doc,
      values,
      placeholder: this.placeholder && d.values.includes('retailLossPct'),
      simulated: d.simulated,
      reviewStatus: d.reviewStatus,
      contentHash,
    };
  }
}
