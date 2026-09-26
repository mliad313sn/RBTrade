import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  canTransitionIncident,
  incidentPriority,
  needsReview,
  type IncidentCategory,
  type IncidentLevel,
  type IncidentPriority,
  type IncidentState,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';

export interface IncidentRow {
  id: string;
  ref: string;
  title: string;
  description: string;
  category: IncidentCategory;
  exercise: boolean;
  alert_id: string | null;
  status: IncidentState;
  impact: IncidentLevel | null;
  urgency: IncidentLevel | null;
  priority: IncidentPriority | null;
  resolution: string | null;
  review_ref: string | null;
  detected_at: Date;
  logged_at: Date;
  logged_by: string;
  classified_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
}

export const incidentView = (r: IncidentRow) => ({
  id: r.id,
  ref: r.ref,
  title: r.title,
  description: r.description,
  category: r.category,
  exercise: r.exercise,
  alertId: r.alert_id,
  status: r.status,
  impact: r.impact,
  urgency: r.urgency,
  priority: r.priority,
  resolution: r.resolution,
  reviewRef: r.review_ref,
  detectedAt: r.detected_at.toISOString(),
  loggedAt: r.logged_at.toISOString(),
  loggedBy: r.logged_by,
  classifiedAt: r.classified_at?.toISOString() ?? null,
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  closedAt: r.closed_at?.toISOString() ?? null,
});

/**
 * Incident register aligned with ITIL 4 incident management (goal 09): detect → log → classify
 * (impact × urgency → P1–P4) → resolve → close with a post-incident review (required for P1/P2).
 * Every transition is audited; incidents are never deleted.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(q: { open?: boolean; limit?: number } = {}) {
    const rows = await this.db.query<IncidentRow>(
      `SELECT * FROM incidents ${q.open ? `WHERE status <> 'closed'` : ''} ORDER BY logged_at DESC LIMIT $1`,
      [Math.min(q.limit ?? 100, 500)],
    );
    return rows.map(incidentView);
  }

  async get(id: string) {
    return incidentView(await this.row(this.db.pool, id));
  }

  private async row(c: Queryable, id: string, lock = false): Promise<IncidentRow> {
    const r = await c.query<IncidentRow>(`SELECT * FROM incidents WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!r.rows[0]) throw new NotFoundException({ error: 'not_found', message: 'No such incident.' });
    return r.rows[0];
  }

  private async record(c: Queryable, userId: string, action: string, r: IncidentRow, extra: Record<string, string | boolean | null> = {}) {
    await this.audit.record(
      {
        actorId: userId,
        actorType: 'user',
        action,
        entity: 'incident',
        entityId: r.id,
        payload: { incidentId: r.id, ref: r.ref, status: r.status, priority: r.priority, category: r.category, exercise: r.exercise, ...extra },
      },
      c,
    );
  }

  async create(
    userId: string,
    body: { title: string; description: string; category: IncidentCategory; detectedAt?: string; alertId?: string; exercise: boolean },
  ) {
    return this.db.tx(async (c) => {
      if (body.alertId) {
        const a = await c.query('SELECT 1 FROM alerts WHERE id = $1', [body.alertId]);
        if (!a.rowCount) throw new BadRequestException({ error: 'unknown_alert', message: 'No such alert.' });
      }
      const r = (
        await c.query<IncidentRow>(
          `INSERT INTO incidents (title, description, category, exercise, alert_id, detected_at, logged_by)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, clock_timestamp()), $7) RETURNING *`,
          [body.title, body.description, body.category, body.exercise, body.alertId ?? null, body.detectedAt ?? null, userId],
        )
      ).rows[0]!;
      await this.record(c, userId, 'incident.logged', r, { alertId: body.alertId ?? null, detectedAt: r.detected_at.toISOString() });
      return incidentView(r);
    });
  }

  private async transition(
    userId: string,
    id: string,
    to: IncidentState,
    apply: (r: IncidentRow, c: Queryable) => Promise<IncidentRow>,
    extra: (r: IncidentRow) => Record<string, string | boolean | null>,
  ) {
    return this.db.tx(async (c) => {
      const cur = await this.row(c, id, true);
      if (!canTransitionIncident(cur.status, to))
        throw new ConflictException({ error: 'invalid_transition', message: `An incident that is ${cur.status} cannot become ${to}.` });
      const r = await apply(cur, c);
      await this.record(c, userId, `incident.${to}`, r, extra(r));
      return incidentView(r);
    });
  }

  classify(userId: string, id: string, body: { impact: IncidentLevel; urgency: IncidentLevel; category?: IncidentCategory; note?: string }) {
    const priority = incidentPriority(body.impact, body.urgency);
    return this.transition(
      userId,
      id,
      'classified',
      async (cur, c) =>
        (
          await c.query<IncidentRow>(
            `UPDATE incidents SET status = 'classified', impact = $2, urgency = $3, priority = $4, category = COALESCE($5, category),
               classified_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
            [cur.id, body.impact, body.urgency, priority, body.category ?? null],
          )
        ).rows[0]!,
      () => ({ impact: body.impact, urgency: body.urgency, note: body.note ?? null }),
    );
  }

  resolve(userId: string, id: string, body: { resolution: string }) {
    return this.transition(
      userId,
      id,
      'resolved',
      async (cur, c) =>
        (
          await c.query<IncidentRow>(
            `UPDATE incidents SET status = 'resolved', resolution = $2, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1 RETURNING *`,
            [cur.id, body.resolution],
          )
        ).rows[0]!,
      () => ({ resolution: body.resolution.slice(0, 500) }),
    );
  }

  close(userId: string, id: string, body: { reviewRef?: string; note?: string }) {
    return this.transition(
      userId,
      id,
      'closed',
      async (cur, c) => {
        if (needsReview(cur.priority) && !body.reviewRef)
          throw new BadRequestException({
            error: 'review_required',
            message: `${cur.priority} incidents close only with a post-incident review reference (docs/runbooks/post-incident-review-template.md).`,
          });
        return (
          await c.query<IncidentRow>(
            `UPDATE incidents SET status = 'closed', review_ref = COALESCE($2, review_ref), closed_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1 RETURNING *`,
            [cur.id, body.reviewRef ?? null],
          )
        ).rows[0]!;
      },
      () => ({ reviewRef: body.reviewRef ?? null, note: body.note ?? null }),
    );
  }
}
