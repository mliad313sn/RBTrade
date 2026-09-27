import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';
import {
  DISCLOSURE_REGISTRY,
  type AcknowledgementContext,
  type AcknowledgementRecord,
  type DisclosureDocument,
  type DisclosureLocale,
  type DisclosureRegistry,
} from './disclosure.types';

interface AckRow {
  id: string;
  disclosure_id: string;
  version: string;
  content_hash: string;
  locale: DisclosureLocale;
  rendered_values: Record<string, string>;
  context: AcknowledgementContext;
  created_at: Date;
  jurisdiction?: string;
}

const toRecord = (r: AckRow): AcknowledgementRecord => ({
  id: r.id,
  disclosureId: r.disclosure_id,
  version: r.version,
  contentHash: r.content_hash,
  locale: r.locale,
  values: r.rendered_values,
  context: r.context,
  at: r.created_at.toISOString(),
  jurisdiction: r.jurisdiction ?? 'GLOBAL',
});

export interface AcknowledgementWithDocument extends AcknowledgementRecord {
  userId: string;
  /** The document exactly as acknowledged, re-rendered from the registry version and stored values. */
  document: DisclosureDocument | null;
  /** True when the re-rendered text hashes to the stored content hash. */
  verified: boolean;
  /** True when this acknowledgement still matches the version and values in force now. */
  inForceNow: boolean;
}

/**
 * Acknowledgements bound to the exact document shown (version + content hash + rendered values).
 * "Acknowledged" means: the latest acknowledgement matches the current version and the current
 * values in any locale (a translation is the same statement; a new figure is not).
 */
@Injectable()
export class DisclosureAcknowledgements {
  constructor(
    @Inject(DISCLOSURE_REGISTRY) private readonly registry: DisclosureRegistry,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  document(id: string, locale: DisclosureLocale): DisclosureDocument {
    const doc = this.registry.current(id, locale);
    if (!doc)
      throw new NotFoundException({
        error: 'not_found',
        message: 'No such disclosure is published.',
      });
    return doc;
  }

  async latest(userId: string, id: string, c?: Queryable): Promise<AcknowledgementRecord | null> {
    const r = await (c ?? this.db.pool).query<AckRow>(
      'SELECT * FROM disclosure_acknowledgements WHERE user_id = $1 AND disclosure_id = $2 ORDER BY created_at DESC LIMIT 1',
      [userId, id],
    );
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  /** True when the user acknowledged the version and values in force now. */
  async isCurrent(userId: string, id: string, c?: Queryable): Promise<boolean> {
    const ack = await this.latest(userId, id, c);
    if (!ack) return false;
    const doc = this.registry.current(id, ack.locale);
    return (
      !!doc &&
      doc.version === ack.version &&
      doc.contentHash === ack.contentHash &&
      JSON.stringify(doc.values) === JSON.stringify(ack.values)
    );
  }

  async record(
    userId: string,
    id: string,
    body: {
      version: string;
      contentHash: string;
      locale: DisclosureLocale;
      context: AcknowledgementContext;
    },
    /** Run inside the caller's transaction (e.g. the appropriateness pass, IRTC R4-09). */
    tx?: Queryable,
  ): Promise<AcknowledgementRecord> {
    const doc = this.document(id, body.locale);
    if (doc.version !== body.version || doc.contentHash !== body.contentHash)
      throw new ConflictException({
        error: 'disclosure_changed',
        message:
          'This text has changed since you opened it. Read the new version and confirm again.',
        current: { version: doc.version, contentHash: doc.contentHash },
      });
    const run = async (c: Queryable) => {
      const r = await c.query<AckRow>(
        `INSERT INTO disclosure_acknowledgements (user_id, disclosure_id, version, content_hash, locale, rendered_values, context, jurisdiction)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          userId,
          id,
          doc.version,
          doc.contentHash,
          body.locale,
          JSON.stringify(doc.values),
          body.context,
          doc.jurisdiction ?? 'GLOBAL',
        ],
      );
      const row = r.rows[0]!;
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'disclosure.acknowledged',
          entity: 'disclosure',
          entityId: id,
          payload: {
            acknowledgementId: row.id,
            disclosureId: id,
            version: doc.version,
            contentHash: doc.contentHash,
            locale: body.locale,
            values: doc.values,
            placeholder: doc.placeholder,
            context: body.context,
            jurisdiction: doc.jurisdiction ?? 'GLOBAL',
          },
        },
        c,
      );
      return toRecord(row);
    };
    return tx ? run(tx) : this.db.tx(run);
  }

  /**
   * Goal 09: every acknowledgement of a user (optionally one disclosure), each with the document
   * version in force when it was given, re-rendered from the registry and verified by content hash.
   */
  async history(userId: string, id?: string): Promise<AcknowledgementWithDocument[]> {
    const rows = await this.db.query<AckRow & { user_id: string }>(
      `SELECT * FROM disclosure_acknowledgements WHERE user_id = $1 ${id ? 'AND disclosure_id = $2' : ''} ORDER BY created_at DESC LIMIT 500`,
      id ? [userId, id] : [userId],
    );
    const out: AcknowledgementWithDocument[] = [];
    for (const r of rows) {
      const rec = toRecord(r);
      const doc =
        this.registry.render?.(
          rec.disclosureId,
          rec.version,
          rec.jurisdiction ?? 'GLOBAL',
          rec.locale,
          rec.values,
        ) ?? null;
      const now = this.registry.current(rec.disclosureId, rec.locale);
      out.push({
        ...rec,
        userId: r.user_id,
        document: doc,
        verified: !!doc && doc.contentHash === rec.contentHash,
        inForceNow:
          !!now &&
          now.version === rec.version &&
          now.contentHash === rec.contentHash &&
          JSON.stringify(now.values) === JSON.stringify(rec.values),
      });
    }
    return out;
  }
}
