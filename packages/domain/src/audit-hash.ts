// Node-only audit hashing (uses node:crypto). Import from '@kora/domain/server'.
import { createHash } from 'node:crypto';

import {
  canonicalJson,
  GENESIS_HASH,
  type ActorType,
  type AuditEvent,
  type ChainVerification,
  type JsonValue,
} from './audit.js';

export interface HashableAuditFields {
  id: string;
  ts: string;
  actorId: string;
  actorType: ActorType;
  action: string;
  entity: string;
  entityId: string | null;
  payload: JsonValue;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** hash = SHA-256(canonical_json(fields) + prev_hash) — ADR 0102. */
export function computeAuditHash(fields: HashableAuditFields, prevHash: string): string {
  const body = canonicalJson({
    id: fields.id,
    ts: fields.ts,
    actor_id: fields.actorId,
    actor_type: fields.actorType,
    action: fields.action,
    entity: fields.entity,
    entity_id: fields.entityId,
    payload: fields.payload,
  });
  return sha256Hex(body + prevHash);
}

/**
 * Incremental verifier so large chains can be streamed page by page.
 */
export class AuditChainVerifier {
  private prevHash = GENESIS_HASH;
  private prevId: bigint | null = null;
  private count = 0;
  private broken: Pick<ChainVerification, 'firstBrokenId' | 'reason'> | null = null;

  push(event: AuditEvent): boolean {
    if (this.broken) return false;
    this.count += 1;
    const id = BigInt(event.id);
    if (this.prevId !== null && id !== this.prevId + 1n) {
      this.broken = { firstBrokenId: event.id, reason: 'id_gap' };
      return false;
    }
    if (event.prevHash !== this.prevHash) {
      this.broken = { firstBrokenId: event.id, reason: 'prev_hash_mismatch' };
      return false;
    }
    let expected: string;
    try {
      expected = computeAuditHash(event, event.prevHash);
    } catch {
      this.broken = { firstBrokenId: event.id, reason: 'hash_mismatch' };
      return false;
    }
    if (expected !== event.hash) {
      this.broken = { firstBrokenId: event.id, reason: 'hash_mismatch' };
      return false;
    }
    this.prevHash = event.hash;
    this.prevId = id;
    return true;
  }

  result(): ChainVerification {
    return {
      valid: this.broken === null,
      count: this.count,
      firstBrokenId: this.broken?.firstBrokenId ?? null,
      reason: this.broken?.reason ?? null,
      headHash: this.prevHash,
    };
  }
}

export function verifyAuditChain(events: Iterable<AuditEvent>): ChainVerification {
  const v = new AuditChainVerifier();
  for (const e of events) if (!v.push(e)) break;
  return v.result();
}
