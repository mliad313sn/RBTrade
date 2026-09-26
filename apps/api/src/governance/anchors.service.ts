import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { canonicalJson } from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { GOVERNANCE_CONFIG, type GovernanceConfig } from './governance-config';

export interface AnchorRow {
  id: string;
  head_id: string;
  head_hash: string;
  event_count: string;
  algorithm: 'ES256';
  key_id: string;
  public_jwk: JsonWebKey;
  signature: string;
  created_by: string;
  anchored_at: Date;
}

export interface AnchorCheck {
  id: string;
  headId: string;
  headHash: string;
  eventCount: number;
  anchoredAt: string;
  keyId: string;
  createdBy: string;
  signatureValid: boolean;
  matchesChain: boolean;
}

/** The exact bytes that are signed (canonical JSON, keys sorted). */
export function anchorMessage(a: { headId: string; headHash: string; eventCount: string; anchoredAt: string }): string {
  return canonicalJson({ headId: a.headId, headHash: a.headHash, eventCount: a.eventCount, anchoredAt: a.anchoredAt });
}

/**
 * Signed anchors of the audit head (B-007, ADR 0102 consequence). Each anchor signs {head id, head
 * hash, event count, time} with an ES256 key (KORA_AUDIT_ANCHOR_JWK; ephemeral in dev/test) and is
 * stored in `audit_anchors` and appended to a JSON-lines file in KORA_AUDIT_ANCHOR_DIR (the WORM
 * stand-in; real object-lock storage is a deployment item). An insider who rewrites the whole chain
 * consistently still cannot match the anchors held outside the database.
 */
@Injectable()
export class AnchorsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('AuditAnchors');
  private readonly key: KeyObject;
  private readonly publicJwk: JsonWebKey;
  readonly keyId: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(GOVERNANCE_CONFIG) private readonly cfg: GovernanceConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {
    this.key = cfg.anchorJwk
      ? createPrivateKey({ key: JSON.parse(cfg.anchorJwk) as JsonWebKey, format: 'jwk' })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const pub = createPublicKey(this.key).export({ format: 'jwk' });
    this.publicJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };
    this.keyId = createHash('sha256').update(canonicalJson(this.publicJwk as Record<string, string>)).digest('hex').slice(0, 16);
  }

  onApplicationBootstrap(): void {
    if (this.cfg.anchorIntervalMs > 0) {
      this.timer = setInterval(() => void this.anchor('system:anchor-job').catch((e: Error) => this.log.warn(e.message)), this.cfg.anchorIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async anchor(createdBy: string): Promise<AnchorCheck> {
    const head = (
      await this.db.query<{ id: string | null; hash: string | null; n: string }>(
        `SELECT h.id, h.hash, (SELECT count(*)::text FROM audit_events) AS n
         FROM (SELECT 1) one
         LEFT JOIN (SELECT e.id::text AS id, e.hash FROM audit_events e ORDER BY e.id DESC LIMIT 1) h ON true`,
      )
    )[0]!;
    const anchoredAt = new Date().toISOString();
    const fields = { headId: head.id ?? '0', headHash: head.hash ?? '0'.repeat(64), eventCount: head.n, anchoredAt };
    const signature = sign('sha256', Buffer.from(anchorMessage(fields)), { key: this.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const row = (
      await this.db.query<AnchorRow>(
        `INSERT INTO audit_anchors (head_id, head_hash, event_count, algorithm, key_id, public_jwk, signature, created_by, anchored_at)
         VALUES ($1, $2, $3, 'ES256', $4, $5::jsonb, $6, $7, $8) RETURNING *`,
        [fields.headId, fields.headHash, fields.eventCount, this.keyId, JSON.stringify(this.publicJwk), signature, createdBy, anchoredAt],
      )
    )[0]!;
    if (this.cfg.anchorDir) {
      mkdirSync(this.cfg.anchorDir, { recursive: true });
      appendFileSync(
        join(this.cfg.anchorDir, 'audit-anchors.jsonl'),
        `${JSON.stringify({ ...fields, algorithm: 'ES256', keyId: this.keyId, publicJwk: this.publicJwk, signature })}\n`,
      );
    }
    await this.audit.record({
      actorId: createdBy,
      actorType: createdBy.startsWith('system') ? 'system' : 'user',
      action: 'internal_audit.anchor_created',
      entity: 'audit_anchor',
      entityId: row.id,
      payload: { anchorId: row.id, headId: fields.headId, headHash: fields.headHash, eventCount: fields.eventCount, keyId: this.keyId },
    });
    return (await this.check([row]))[0]!;
  }

  async list(from?: Date, to?: Date): Promise<AnchorCheck[]> {
    const rows = await this.db.query<AnchorRow>(
      `SELECT id::text AS id, head_id::text AS head_id, head_hash, event_count::text AS event_count, algorithm, key_id, public_jwk,
              signature, created_by, anchored_at
       FROM audit_anchors WHERE ($1::timestamptz IS NULL OR anchored_at >= $1) AND ($2::timestamptz IS NULL OR anchored_at < $2)
       ORDER BY anchored_at DESC LIMIT 500`,
      [from ?? null, to ?? null],
    );
    return this.check(rows);
  }

  /** Verifies each anchor's signature and that the anchored hash is still in the chain at that id. */
  async check(rows: AnchorRow[]): Promise<AnchorCheck[]> {
    const ids = rows.map((r) => String(r.head_id));
    const chain = new Map(
      (
        await this.db.query<{ id: string; hash: string }>('SELECT id::text AS id, hash FROM audit_events WHERE id = ANY($1::bigint[])', [ids])
      ).map((r) => [r.id, r.hash]),
    );
    return rows.map((r) => {
      const anchoredAt = r.anchored_at.toISOString();
      const fields = { headId: String(r.head_id), headHash: r.head_hash, eventCount: String(r.event_count), anchoredAt };
      let signatureValid = false;
      try {
        signatureValid = verify(
          'sha256',
          Buffer.from(anchorMessage(fields)),
          { key: createPublicKey({ key: r.public_jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
          Buffer.from(r.signature, 'base64url'),
        );
      } catch {
        signatureValid = false;
      }
      return {
        id: String(r.id),
        headId: fields.headId,
        headHash: r.head_hash,
        eventCount: Number(r.event_count),
        anchoredAt,
        keyId: r.key_id,
        createdBy: r.created_by,
        signatureValid,
        matchesChain: fields.headId === '0' ? true : chain.get(fields.headId) === r.head_hash,
      };
    });
  }
}
