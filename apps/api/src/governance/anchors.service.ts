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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { canonicalJson, type AnchorWitness } from '@kora/domain';

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
  /** Signature valid under a pinned, trusted key (never the key stored in the row). */
  signatureValid: boolean;
  /** The row's key id is one of the configured trusted keys (IRTC R4-07). */
  trustedKey: boolean;
  matchesChain: boolean;
}

/** Key id of a public EC JWK: first 16 hex chars of the SHA-256 of its canonical JSON. */
export function keyIdOf(jwk: JsonWebKey): string {
  const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as Record<string, string>;
  return createHash('sha256').update(canonicalJson(pub)).digest('hex').slice(0, 16);
}

/**
 * IRTC R4-07: verifies an anchor signature with the trusted key named by its key id. A row signed
 * with any other key (for example one an insider generated and stored in the row) is not valid.
 */
export function verifyAnchorSignature(
  a: { headId: string; headHash: string; eventCount: string; anchoredAt: string; keyId: string; signature: string },
  trusted: ReadonlyMap<string, KeyObject>,
): { signatureValid: boolean; trustedKey: boolean } {
  const key = trusted.get(a.keyId);
  if (!key) return { signatureValid: false, trustedKey: false };
  try {
    return {
      trustedKey: true,
      signatureValid: verify(
        'sha256',
        Buffer.from(anchorMessage(a)),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(a.signature, 'base64url'),
      ),
    };
  } catch {
    return { signatureValid: false, trustedKey: true };
  }
}

/**
 * IRTC R4-07: the latest trusted anchor as a witness of the chain head. The chain must still hold
 * at least the anchored number of events and the anchored hash at the anchored id; a deleted tail or
 * a consistent rewrite of anchored events fails it.
 */
export function witnessOf(
  anchor: { id: string; headId: string; headHash: string; eventCount: number; anchoredAt: string },
  chain: { count: number; hashAtHead: string | null },
): AnchorWitness {
  const truncated = anchor.headId !== '0' && (chain.hashAtHead === null || chain.count < anchor.eventCount);
  return {
    anchorId: anchor.id,
    anchoredHeadId: anchor.headId,
    anchoredEventCount: anchor.eventCount,
    anchoredAt: anchor.anchoredAt,
    chainCount: chain.count,
    eventsAfterLastAnchor: Math.max(0, chain.count - anchor.eventCount),
    truncated,
    mismatch: !truncated && anchor.headId !== '0' && chain.hashAtHead !== anchor.headHash,
  };
}

/** Result of checking the external (WORM) copy of the anchors against the database and the chain. */
export interface WormCheck {
  configured: boolean;
  fileAnchors: number;
  invalidSignatures: number;
  missingInDatabase: number;
  notMatchingChain: number;
  unreadableLines: number;
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
export class AnchorsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('AuditAnchors');
  private readonly key: KeyObject;
  private readonly publicJwk: JsonWebKey;
  readonly keyId: string;
  /** IRTC R4-07: pinned public keys by key id (the current key plus configured rotated keys). */
  private readonly trusted = new Map<string, KeyObject>();
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
    this.keyId = keyIdOf(this.publicJwk);
    this.trusted.set(this.keyId, createPublicKey({ key: this.publicJwk, format: 'jwk' }));
    if (cfg.anchorTrustedJwks) {
      const extra = JSON.parse(cfg.anchorTrustedJwks) as JsonWebKey[];
      if (!Array.isArray(extra)) throw new Error('KORA_AUDIT_ANCHOR_TRUSTED_JWKS must be a JSON array of public JWKs');
      for (const jwk of extra) this.trusted.set(keyIdOf(jwk), createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' }));
    }
  }

  onModuleInit(): void {
    this.audit.registerHeadWitness(() => this.witness());
  }

  /** The latest anchor with a valid trusted signature, compared with the chain now. */
  async witness(): Promise<AnchorWitness | null> {
    const rows = await this.db.query<AnchorRow>(
      `SELECT id::text AS id, head_id::text AS head_id, head_hash, event_count::text AS event_count, algorithm, key_id, public_jwk,
              signature, created_by, anchored_at
       FROM audit_anchors ORDER BY anchored_at DESC, id DESC LIMIT 50`,
    );
    const latest = rows.find((r) => verifyAnchorSignature(this.fieldsOf(r), this.trusted).signatureValid);
    if (!latest) return null;
    const chain = (
      await this.db.query<{ n: string; hash: string | null }>(
        `SELECT (SELECT count(*)::text FROM audit_events) AS n, (SELECT hash FROM audit_events WHERE id = $1::bigint) AS hash`,
        [String(latest.head_id)],
      )
    )[0]!;
    const f = this.fieldsOf(latest);
    return witnessOf(
      { id: String(latest.id), headId: f.headId, headHash: f.headHash, eventCount: Number(f.eventCount), anchoredAt: f.anchoredAt },
      { count: Number(chain.n), hashAtHead: chain.hash },
    );
  }

  /** IRTC R4-07: the WORM copy is read back and checked, not only written. */
  async wormCheck(): Promise<WormCheck> {
    const out: WormCheck = { configured: !!this.cfg.anchorDir, fileAnchors: 0, invalidSignatures: 0, missingInDatabase: 0, notMatchingChain: 0, unreadableLines: 0 };
    if (!this.cfg.anchorDir) return out;
    const file = join(this.cfg.anchorDir, 'audit-anchors.jsonl');
    if (!existsSync(file)) return out;
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    const parsed: Array<{ headId: string; headHash: string; eventCount: string; anchoredAt: string; keyId: string; signature: string }> = [];
    for (const l of lines) {
      try {
        const j = JSON.parse(l) as Record<string, unknown>;
        parsed.push({
          headId: String(j.headId),
          headHash: String(j.headHash),
          eventCount: String(j.eventCount),
          anchoredAt: String(j.anchoredAt),
          keyId: String(j.keyId),
          signature: String(j.signature),
        });
      } catch {
        out.unreadableLines += 1;
      }
    }
    out.fileAnchors = parsed.length;
    if (!parsed.length) return out;
    const db = await this.db.query<{ head_id: string; head_hash: string; anchored_at: Date }>(
      'SELECT head_id::text AS head_id, head_hash, anchored_at FROM audit_anchors',
    );
    const inDb = new Set(db.map((r) => `${r.head_id}|${r.head_hash}|${r.anchored_at.toISOString()}`));
    const chain = new Map(
      (
        await this.db.query<{ id: string; hash: string }>('SELECT id::text AS id, hash FROM audit_events WHERE id = ANY($1::bigint[])', [
          parsed.map((p) => p.headId).filter((id) => /^\d+$/.test(id)),
        ])
      ).map((r) => [r.id, r.hash]),
    );
    for (const p of parsed) {
      if (!verifyAnchorSignature(p, this.trusted).signatureValid) out.invalidSignatures += 1;
      if (!inDb.has(`${p.headId}|${p.headHash}|${p.anchoredAt}`)) out.missingInDatabase += 1;
      if (p.headId !== '0' && chain.get(p.headId) !== p.headHash) out.notMatchingChain += 1;
    }
    return out;
  }

  private fieldsOf(r: AnchorRow) {
    return {
      headId: String(r.head_id),
      headHash: r.head_hash,
      eventCount: String(r.event_count),
      anchoredAt: r.anchored_at.toISOString(),
      keyId: r.key_id,
      signature: r.signature,
    };
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

  /**
   * Verifies each anchor's signature against the pinned trusted key for its key id (never the
   * row's own public key, IRTC R4-07) and that the anchored hash is still in the chain at that id.
   */
  async check(rows: AnchorRow[]): Promise<AnchorCheck[]> {
    const ids = rows.map((r) => String(r.head_id));
    const chain = new Map(
      (
        await this.db.query<{ id: string; hash: string }>('SELECT id::text AS id, hash FROM audit_events WHERE id = ANY($1::bigint[])', [ids])
      ).map((r) => [r.id, r.hash]),
    );
    return rows.map((r) => {
      const fields = this.fieldsOf(r);
      const anchoredAt = fields.anchoredAt;
      const { signatureValid, trustedKey } = verifyAnchorSignature(fields, this.trusted);
      return {
        id: String(r.id),
        headId: fields.headId,
        headHash: r.head_hash,
        eventCount: Number(r.event_count),
        anchoredAt,
        keyId: r.key_id,
        createdBy: r.created_by,
        signatureValid,
        trustedKey,
        matchesChain: fields.headId === '0' ? true : chain.get(fields.headId) === r.head_hash,
      };
    });
  }
}
