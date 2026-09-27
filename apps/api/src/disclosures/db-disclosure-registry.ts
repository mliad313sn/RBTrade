import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { DbService } from '../db/db.service';
import { GOVERNANCE_CONFIG, type GovernanceConfig } from '../governance/governance-config';
import { retailLossPct } from './config-disclosure-registry';
import {
  definitionChecksum,
  DisclosureDefinitionSchema,
  placeholderFor,
  renderDisclosure,
  type DisclosureDefinition,
} from './disclosure-render';
import type { DisclosureDocument, DisclosureLocale, DisclosureRegistry } from './disclosure.types';
import riskWarningV1 from './risk-warning.v1.json';

/** Bundled, reviewed definitions published on first boot (jurisdiction GLOBAL). */
export const DISCLOSURE_FILES: unknown[] = [riskWarningV1];
/** Goal 08 published risk-warning v1 on this date; bundled files take effect from it. */
export const BUNDLED_EFFECTIVE_FROM = '2026-09-26T00:00:00.000Z';

interface PublishedVersion {
  def: DisclosureDefinition;
  jurisdiction: string;
  effectiveFrom: number;
}

interface ValueVersion {
  value: string | null;
  effectiveFrom: number;
  owner: string;
  openQuestion: string | null;
}

interface DocRow {
  id: string;
  version: string;
  jurisdiction: string;
  locales: DisclosureDefinition['locales'];
  value_keys: string[];
  simulated: boolean;
  review_status: string;
  checksum: string;
  status: 'draft' | 'published';
  effective_from: Date | null;
}

interface ValueRow {
  key: string;
  jurisdiction: string;
  effective_from: Date;
  value: string | null;
  owner: string;
  open_question: string | null;
}

export const toDefinition = (r: DocRow): DisclosureDefinition => ({
  id: r.id,
  version: r.version,
  simulated: r.simulated,
  reviewStatus: r.review_status,
  values: r.value_keys,
  locales: r.locales,
});

/**
 * Compliance-owned disclosures registry (goal 09, replaces the goal 08 config registry behind the
 * same `DisclosureRegistry` interface). Versions are per jurisdiction with an effective date; values
 * (e.g. the retail-loss figure) have their own effective dates and stay placeholders (NULL) until
 * Compliance sets them. Served from an in-memory snapshot so `current()` stays synchronous; the
 * snapshot reloads after every publication and every minute (future effective dates are resolved at
 * read time, so a scheduled version switches on its own).
 */
@Injectable()
export class DbDisclosureRegistry
  implements DisclosureRegistry, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger('Disclosures');
  private versions = new Map<string, PublishedVersion[]>();
  private allVersions = new Map<string, DisclosureDefinition>();
  private values = new Map<string, ValueVersion[]>();
  private timer: NodeJS.Timeout | null = null;
  private loaded = false;
  private readonly envOverride: string | null;

  constructor(
    @Inject(GOVERNANCE_CONFIG) private readonly cfg: GovernanceConfig,
    private readonly db: DbService,
  ) {
    // Before the first load (or without a database) the bundled files are served with placeholders.
    for (const raw of DISCLOSURE_FILES) {
      const def = DisclosureDefinitionSchema.parse(raw);
      this.addVersion(def, 'GLOBAL', Date.parse(BUNDLED_EFFECTIVE_FROM));
    }
    // Dev/test convenience only (goal 08 env): never a source of truth outside dev/test.
    this.envOverride = cfg.env === 'dev' || cfg.env === 'test' ? retailLossPct(process.env) : null;
  }

  private addVersion(def: DisclosureDefinition, jurisdiction: string, effectiveFrom: number) {
    const key = `${def.id}|${jurisdiction}`;
    const list = (this.versions.get(key) ?? []).filter((v) => v.def.version !== def.version);
    list.push({ def, jurisdiction, effectiveFrom });
    list.sort((a, b) => b.effectiveFrom - a.effectiveFrom);
    this.versions.set(key, list);
    this.allVersions.set(`${def.id}|${def.version}|${jurisdiction}`, def);
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sync();
      await this.refresh();
    } catch (e) {
      if ((e as { code?: string }).code !== '42P01') throw e;
      this.log.warn(
        'disclosure registry tables missing; serving bundled placeholders until migrated',
      );
    }
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Publishes bundled definitions that are not in the database yet; refuses edited published text. */
  async sync(): Promise<void> {
    for (const raw of DISCLOSURE_FILES) {
      const def = DisclosureDefinitionSchema.parse(raw);
      const sum = definitionChecksum(def);
      const existing = await this.db.query<{ checksum: string }>(
        `SELECT checksum FROM disclosure_documents WHERE id = $1 AND version = $2 AND jurisdiction = 'GLOBAL'`,
        [def.id, def.version],
      );
      if (existing[0]) {
        if (existing[0].checksum !== sum)
          throw new Error(
            `disclosure ${def.id} v${def.version} changed after publication; publish a new version instead`,
          );
        continue;
      }
      await this.db.query(
        `INSERT INTO disclosure_documents (id, version, jurisdiction, locales, value_keys, simulated, review_status, checksum, status,
           effective_from, drafted_by, approved_by, published_at)
         VALUES ($1, $2, 'GLOBAL', $3::jsonb, $4, $5, $6, $7, 'published', $8, 'system', 'system', clock_timestamp())
         ON CONFLICT DO NOTHING`,
        [
          def.id,
          def.version,
          JSON.stringify(def.locales),
          def.values,
          def.simulated,
          def.reviewStatus,
          sum,
          BUNDLED_EFFECTIVE_FROM,
        ],
      );
    }
  }

  /** Reloads the published versions and values (call after a publication). */
  async refresh(): Promise<void> {
    const docs = await this.db.query<DocRow>(
      `SELECT * FROM disclosure_documents WHERE status = 'published'`,
    );
    const vals = await this.db.query<ValueRow>('SELECT * FROM disclosure_values');
    this.versions = new Map();
    this.allVersions = new Map();
    for (const r of docs)
      this.addVersion(toDefinition(r), r.jurisdiction, r.effective_from!.getTime());
    const values = new Map<string, ValueVersion[]>();
    for (const v of vals) {
      const key = `${v.key}|${v.jurisdiction}`;
      const list = values.get(key) ?? [];
      list.push({
        value: v.value,
        effectiveFrom: v.effective_from.getTime(),
        owner: v.owner,
        openQuestion: v.open_question,
      });
      values.set(key, list);
    }
    for (const list of values.values()) list.sort((a, b) => b.effectiveFrom - a.effectiveFrom);
    this.values = values;
    this.loaded = true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  private jurisdictions(j?: string): string[] {
    const first = j ?? this.cfg.jurisdiction;
    return first === 'GLOBAL' ? ['GLOBAL'] : [first, 'GLOBAL'];
  }

  /** Value of a key in force at `at` for a jurisdiction (falls back to GLOBAL); null = placeholder. */
  valueAt(key: string, at: number, jurisdiction?: string): ValueVersion | null {
    if (key === 'retailLossPct' && this.envOverride)
      return {
        value: this.envOverride,
        effectiveFrom: 0,
        owner: 'env (dev/test)',
        openQuestion: 'OQ-R1',
      };
    for (const j of this.jurisdictions(jurisdiction)) {
      const v = this.values.get(`${key}|${j}`)?.find((x) => x.effectiveFrom <= at);
      if (v) return v;
    }
    return null;
  }

  /** The version in force at `at` (published, effective_from ≤ at), preferring the jurisdiction. */
  versionAt(id: string, at: number, jurisdiction?: string): PublishedVersion | null {
    for (const j of this.jurisdictions(jurisdiction)) {
      const v = this.versions.get(`${id}|${j}`)?.find((x) => x.effectiveFrom <= at);
      if (v) return v;
    }
    return null;
  }

  /** The document in force at a point in time, rendered with the values in force then. */
  at(
    id: string,
    locale: DisclosureLocale,
    at: number,
    jurisdiction?: string,
  ): DisclosureDocument | null {
    const v = this.versionAt(id, at, jurisdiction);
    if (!v) return null;
    const set = Object.fromEntries(
      v.def.values.map((k) => [k, this.valueAt(k, at, v.jurisdiction)?.value ?? null]),
    );
    return renderDisclosure(v.def, locale, set, {
      jurisdiction: v.jurisdiction,
      effectiveFrom: new Date(v.effectiveFrom).toISOString(),
    });
  }

  current(id: string, locale: DisclosureLocale): DisclosureDocument | null {
    return this.at(id, locale, Date.now());
  }

  render(
    id: string,
    version: string,
    jurisdiction: string,
    locale: DisclosureLocale,
    values: Record<string, string>,
  ): DisclosureDocument | null {
    const def = this.allVersions.get(`${id}|${version}|${jurisdiction}`);
    if (!def) return null;
    // Stored values are the rendered strings (a placeholder is stored as "[XX]"): render them verbatim
    // so the content hash is recomputed exactly, and flag the placeholders.
    const doc = renderDisclosure(def, locale, values, { jurisdiction });
    return {
      ...doc,
      placeholder: def.values.some(
        (k) => values[k] === undefined || values[k] === placeholderFor(k),
      ),
    };
  }

  /** Every published version of a disclosure (history for Compliance). */
  history(id: string): Array<{
    version: string;
    jurisdiction: string;
    effectiveFrom: string;
    simulated: boolean;
    reviewStatus: string;
  }> {
    const out = [];
    for (const [key, list] of this.versions)
      if (key.startsWith(`${id}|`))
        for (const v of list)
          out.push({
            version: v.def.version,
            jurisdiction: v.jurisdiction,
            effectiveFrom: new Date(v.effectiveFrom).toISOString(),
            simulated: v.def.simulated,
            reviewStatus: v.def.reviewStatus,
          });
    return out.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  }

  /** Placeholders still open (value NULL in force now), for the open-questions check. */
  placeholders(): Array<{
    key: string;
    jurisdiction: string;
    owner: string;
    openQuestion: string | null;
  }> {
    const now = Date.now();
    const out = [];
    for (const [k, list] of this.values) {
      const [key, jurisdiction] = k.split('|') as [string, string];
      const v = list.find((x) => x.effectiveFrom <= now);
      if (v && v.value === null && !(key === 'retailLossPct' && this.envOverride))
        out.push({ key, jurisdiction, owner: v.owner, openQuestion: v.openQuestion });
    }
    return out;
  }
}
