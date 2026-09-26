import {
  DisclosureDefinitionSchema as DefinitionSchema,
  renderDisclosure,
  type DisclosureDefinition,
} from './disclosure-render';
import type { DisclosureDocument, DisclosureLocale, DisclosureRegistry } from './disclosure.types';
import riskWarningV1 from './risk-warning.v1.json';

type Definition = DisclosureDefinition;

/** The regulatory retail-loss figure: set by Compliance (OQ-R1); the placeholder stays visible. */
export const RETAIL_LOSS_PLACEHOLDER = '[XX]';

export function retailLossPct(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.KORA_DISCLOSURE_RETAIL_LOSS_PCT?.trim();
  if (!raw) return null;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(raw) || Number(raw) > 100)
    throw new Error('KORA_DISCLOSURE_RETAIL_LOSS_PCT must be a percentage such as 74 or 74.5');
  return raw;
}

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
    this.values = pct === null ? {} : { retailLossPct: pct };
    this.placeholder = pct === null;
  }

  current(id: string, locale: DisclosureLocale): DisclosureDocument | null {
    const d = this.defs.get(id);
    if (!d) return null;
    return renderDisclosure(d, locale, this.placeholder ? {} : this.values);
  }
}
