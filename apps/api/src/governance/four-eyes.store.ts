import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { fourEyesViolation, type FourEyesKind, type FourEyesStatus, type JsonValue } from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';
import { GOVERNANCE_CONFIG, type GovernanceConfig } from './governance-config';

export interface FourEyesRow {
  id: string;
  kind: FourEyesKind;
  subject_type: string;
  subject_id: string;
  payload: Record<string, JsonValue>;
  reason: string;
  requested_by: string;
  requested_at: Date;
  expires_at: Date;
  status: FourEyesStatus;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  result: Record<string, JsonValue> | null;
}

export interface FourEyesView {
  id: string;
  kind: FourEyesKind;
  subjectType: string;
  subjectId: string;
  payload: Record<string, JsonValue>;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  status: FourEyesStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  result: Record<string, JsonValue> | null;
}

export const toFourEyesView = (r: FourEyesRow): FourEyesView => ({
  id: r.id,
  kind: r.kind,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  payload: r.payload,
  reason: r.reason,
  requestedBy: r.requested_by,
  requestedAt: r.requested_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  status: r.status,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at?.toISOString() ?? null,
  decisionNote: r.decision_note,
  result: r.result,
});

export interface NewFourEyesRequest {
  kind: FourEyesKind;
  subjectType: string;
  subjectId: string;
  payload: Record<string, JsonValue>;
  reason: string;
  requestedBy: string;
}

/**
 * Storage and the invariant of the four-eyes engine (goal 09): the approver is never the requester.
 * Kept free of business services so the trading core (kill-switch resume) can create requests
 * without a module cycle; approval executors live in `FourEyesService`.
 */
@Injectable()
export class FourEyesStore {
  constructor(
    @Inject(GOVERNANCE_CONFIG) private readonly cfg: GovernanceConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async create(req: NewFourEyesRequest, c?: Queryable): Promise<FourEyesRow> {
    const run = async (q: Queryable) => {
      await this.expireStale(q);
      const existing = await q.query<{ id: string }>(
        `SELECT id FROM four_eyes_requests WHERE kind = $1 AND subject_id = $2 AND status = 'pending'`,
        [req.kind, req.subjectId],
      );
      if (existing.rows[0])
        throw new ConflictException({
          error: 'four_eyes_pending',
          message: 'A request for this is already waiting for a second person.',
          requestId: existing.rows[0].id,
        });
      // The partial unique index still guards a concurrent duplicate (the insert then fails).
      const row = (
        await q.query<FourEyesRow>(
          `INSERT INTO four_eyes_requests (kind, subject_type, subject_id, payload, reason, requested_by, expires_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, clock_timestamp() + $7 * interval '1 millisecond') RETURNING *`,
          [req.kind, req.subjectType, req.subjectId, JSON.stringify(req.payload), req.reason, req.requestedBy, this.cfg.fourEyesTtlMs],
        )
      ).rows[0]!;
      await this.audit.record(
        {
          actorId: req.requestedBy,
          actorType: 'user',
          action: 'four_eyes.requested',
          entity: 'four_eyes_request',
          entityId: row.id,
          payload: {
            requestId: row.id,
            kind: req.kind,
            subjectType: req.subjectType,
            subjectId: req.subjectId,
            reason: req.reason,
            request: req.payload,
            ...(req.subjectType === 'account' ? { accountId: req.subjectId } : {}),
          },
        },
        q,
      );
      return row;
    };
    return c ? run(c) : this.db.tx(run);
  }

  async get(id: string, c?: Queryable): Promise<FourEyesRow> {
    const r = await (c ?? this.db.pool).query<FourEyesRow>('SELECT * FROM four_eyes_requests WHERE id = $1', [id]);
    if (!r.rows[0]) throw new NotFoundException({ error: 'not_found', message: 'No such request.' });
    return r.rows[0];
  }

  async list(q: { status?: FourEyesStatus; kind?: FourEyesKind; subjectId?: string; limit?: number } = {}): Promise<FourEyesRow[]> {
    await this.expireStale(this.db.pool);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) where.push(`status = $${params.push(q.status)}`);
    if (q.kind) where.push(`kind = $${params.push(q.kind)}`);
    if (q.subjectId) where.push(`subject_id = $${params.push(q.subjectId)}`);
    params.push(Math.min(Math.max(q.limit ?? 100, 1), 500));
    return this.db.query<FourEyesRow>(
      `SELECT * FROM four_eyes_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC LIMIT $${params.length}`,
      params,
    );
  }

  /** Marks overdue pending requests as expired (lazy: no scheduler needed). */
  async expireStale(q: Queryable): Promise<void> {
    await q.query(
      `UPDATE four_eyes_requests SET status = 'expired', decided_at = clock_timestamp()
       WHERE status = 'pending' AND expires_at <= clock_timestamp()`,
    );
  }

  /** Locks a pending request for a decision; enforces "not the requester". */
  async lockPending(c: Queryable, id: string, deciderId: string): Promise<FourEyesRow> {
    await this.expireStale(c);
    const r = await c.query<FourEyesRow>('SELECT * FROM four_eyes_requests WHERE id = $1 FOR UPDATE', [id]);
    const row = r.rows[0];
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such request.' });
    if (row.status !== 'pending')
      throw new ConflictException({ error: 'not_pending', message: `This request is already ${row.status}.`, status: row.status });
    if (fourEyesViolation(row.requested_by, deciderId))
      throw new ForbiddenException({
        error: 'four_eyes',
        message: 'Four-eyes rule: you cannot approve or reject your own request. Another authorised person must decide.',
      });
    return row;
  }

  async decide(
    c: Queryable,
    row: FourEyesRow,
    deciderId: string,
    status: 'approved' | 'rejected' | 'cancelled',
    note: string | null,
    result: Record<string, JsonValue> | null = null,
  ): Promise<FourEyesRow> {
    const upd = (
      await c.query<FourEyesRow>(
        `UPDATE four_eyes_requests SET status = $2, decided_by = $3, decided_at = clock_timestamp(), decision_note = $4, result = $5::jsonb
         WHERE id = $1 RETURNING *`,
        [row.id, status, deciderId, note, result === null ? null : JSON.stringify(result)],
      )
    ).rows[0]!;
    await this.audit.record(
      {
        actorId: deciderId,
        actorType: 'user',
        action: `four_eyes.${status}`,
        entity: 'four_eyes_request',
        entityId: row.id,
        payload: {
          requestId: row.id,
          kind: row.kind,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          requestedBy: row.requested_by,
          decidedBy: deciderId,
          note,
          ...(result ? { result } : {}),
          ...(row.subject_type === 'account' ? { accountId: row.subject_id } : {}),
        },
      },
      c,
    );
    return upd;
  }
}
