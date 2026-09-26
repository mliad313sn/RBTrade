import { Injectable } from '@nestjs/common';
import {
  canonicalJson,
  GENESIS_HASH,
  type ActorType,
  type AuditEvent,
  type ChainVerification,
  type JsonValue,
} from '@kora/domain';
import { AuditChainVerifier, computeAuditHash } from '@kora/domain/server';

import { DbService, type Queryable } from '../db/db.service';

export interface AuditRecordInput {
  actorId: string;
  actorType: ActorType;
  action: string;
  entity: string;
  entityId?: string | null;
  payload?: Record<string, JsonValue>;
}

export interface AuditQuery {
  actorId?: string;
  actorType?: ActorType;
  entity?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  beforeId?: string;
  limit?: number;
}

const TS_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const CHAIN_LOCK = "hashtext('kora.audit_chain')";
const SELECT_COLUMNS = `id::text AS id, to_char(ts AT TIME ZONE 'UTC', ${TS_FORMAT}) AS ts, actor_id, actor_type,
  action, entity, entity_id, payload, prev_hash, hash`;

interface AuditRow {
  id: string;
  ts: string;
  actor_id: string;
  actor_type: ActorType;
  action: string;
  entity: string;
  entity_id: string | null;
  payload: JsonValue;
  prev_hash: string;
  hash: string;
}

function toEvent(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    ts: r.ts,
    actorId: r.actor_id,
    actorType: r.actor_type,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    payload: r.payload,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/**
 * Append-only, hash-chained audit log (ADR 0102). Every later module records through here.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /**
   * Appends one event. Pass `client` to commit atomically with a business change; the caller's
   * transaction must be READ COMMITTED (the default).
   */
  async record(input: AuditRecordInput, client?: Queryable): Promise<AuditEvent> {
    const payload = input.payload ?? {};
    canonicalJson(payload); // fail fast on floats / unsupported values, before taking the lock
    if (client) return this.append(client, input, payload);
    return this.db.tx((c) => this.append(c, input, payload));
  }

  private async append(c: Queryable, input: AuditRecordInput, payload: Record<string, JsonValue>): Promise<AuditEvent> {
    const iso = await c.query<{ transaction_isolation: string }>('SHOW transaction_isolation');
    if (iso.rows[0]?.transaction_isolation !== 'read committed') {
      throw new Error('AuditService.record requires a READ COMMITTED transaction');
    }
    await c.query(`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`);
    const head = await c.query<{ id: string; hash: string }>(
      'SELECT id::text AS id, hash FROM audit_events ORDER BY audit_events.id DESC LIMIT 1',
    );
    const prevHash = head.rows[0]?.hash ?? GENESIS_HASH;
    const id = (BigInt(head.rows[0]?.id ?? '0') + 1n).toString();
    const tsRes = await c.query<{ ts: string }>(
      `SELECT to_char(date_trunc('microseconds', clock_timestamp()) AT TIME ZONE 'UTC', ${TS_FORMAT}) AS ts`,
    );
    const ts = tsRes.rows[0]!.ts;
    const fields = {
      id,
      ts,
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      payload,
    };
    const hash = computeAuditHash(fields, prevHash);
    await c.query(
      `INSERT INTO audit_events (id, ts, actor_id, actor_type, action, entity, entity_id, payload, prev_hash, hash)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [id, ts, fields.actorId, fields.actorType, fields.action, fields.entity, fields.entityId, JSON.stringify(payload), prevHash, hash],
    );
    return { ...fields, prevHash, hash };
  }

  async list(q: AuditQuery): Promise<{ events: AuditEvent[]; nextBeforeId: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.actorId) add('actor_id = ?', q.actorId);
    if (q.actorType) add('actor_type = ?', q.actorType);
    if (q.entity) add('entity = ?', q.entity);
    if (q.entityId) add('entity_id = ?', q.entityId);
    if (q.action) {
      if (q.action.endsWith('.*')) add("action LIKE ? || '.%'", q.action.slice(0, -2));
      else add('action = ?', q.action);
    }
    if (q.from) add('ts >= ?::timestamptz', q.from);
    if (q.to) add('ts < ?::timestamptz', q.to);
    if (q.beforeId) add('id < ?::bigint', q.beforeId);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    params.push(limit + 1);
    const rows = await this.db.query<AuditRow>(
      `SELECT ${SELECT_COLUMNS} FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY audit_events.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit).map(toEvent);
    return { events: page, nextBeforeId: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  /** Recomputes the entire chain in id order, streamed in pages. */
  async verify(pageSize = 1000): Promise<ChainVerification> {
    const verifier = new AuditChainVerifier();
    let after = '0';
    let first = true;
    for (;;) {
      const rows = await this.db.query<AuditRow>(
        `SELECT ${SELECT_COLUMNS} FROM audit_events WHERE id > $1::bigint ORDER BY audit_events.id ASC LIMIT $2`,
        [after, pageSize],
      );
      if (rows.length === 0) break;
      for (const r of rows) {
        const e = toEvent(r);
        if (first && e.id !== '1') {
          return { ...verifier.result(), valid: false, count: 1, firstBrokenId: e.id, reason: 'id_gap' };
        }
        first = false;
        if (!verifier.push(e)) return verifier.result();
      }
      after = rows[rows.length - 1]!.id;
      if (rows.length < pageSize) break;
    }
    return verifier.result();
  }
}
