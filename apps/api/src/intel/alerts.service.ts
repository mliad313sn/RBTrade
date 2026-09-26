import { Injectable, NotFoundException } from '@nestjs/common';
import { ASSET_CLASSES, SYMBOL_RE } from '@kora/domain';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { RADAR_REGIONS, radarRegion, sectorOf } from './core/taxonomy';

export const TREND_KINDS = [
  'up',
  'down',
  'range',
  'breakout_up',
  'breakout_down',
  'reversal',
  'vol_regime',
] as const;

export const AlertRuleSchema = z.strictObject({
  trendKinds: z.array(z.enum(TREND_KINDS)).min(1).max(7),
  region: z.enum(RADAR_REGIONS).optional(),
  assetClass: z.enum(ASSET_CLASSES).optional(),
  sector: z
    .string()
    .regex(/^[a-z_]{2,32}$/)
    .optional(),
  symbol: z.string().regex(SYMBOL_RE).optional(),
  minScore: z.number().min(0).max(1).default(0.5),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export const CreateAlertSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  rule: AlertRuleSchema,
});

/**
 * Market Radar alerts (goal 07B §6): the rule is stored on the server and evaluated by the server
 * after every scan; a match writes an alert event the user reads. Alerts only notify: nothing is
 * drafted or placed.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string) {
    const alerts = await this.db.query<{
      id: string;
      name: string;
      rule: AlertRule;
      active: boolean;
      created_at: Date;
    }>(
      'SELECT id, name, rule, active, created_at FROM intel_alerts WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    const events = await this.db.query<{
      id: string;
      alert_id: string;
      symbol: string;
      detail: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id::text, alert_id, symbol, detail, created_at FROM intel_alert_events
        WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
      [userId],
    );
    return {
      alerts: alerts.map((a) => ({
        id: a.id,
        name: a.name,
        rule: a.rule,
        active: a.active,
        createdAt: a.created_at.toISOString(),
      })),
      events: events.map((e) => ({
        id: e.id,
        alertId: e.alert_id,
        symbol: e.symbol,
        detail: e.detail,
        createdAt: e.created_at.toISOString(),
      })),
      evaluatedBy: 'server',
    };
  }

  async create(userId: string, body: z.infer<typeof CreateAlertSchema>) {
    return this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        'INSERT INTO intel_alerts (user_id, name, rule) VALUES ($1, $2, $3) RETURNING id',
        [userId, body.name, JSON.stringify(body.rule)],
      );
      const id = r.rows[0]!.id;
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'intel.alert_created',
          entity: 'intel_alert',
          entityId: id,
          payload: {
            name: body.name,
            kinds: body.rule.trendKinds.join(','),
            minScore: String(body.rule.minScore),
          },
        },
        c,
      );
      return { id, name: body.name, rule: body.rule, active: true };
    });
  }

  async remove(userId: string, id: string) {
    return this.db.tx(async (c) => {
      const r = await c.query('DELETE FROM intel_alerts WHERE id = $1 AND user_id = $2', [
        id,
        userId,
      ]);
      if (!r.rowCount)
        throw new NotFoundException({ error: 'not_found', message: 'Alert not found.' });
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'intel.alert_deleted',
          entity: 'intel_alert',
          entityId: id,
          payload: {},
        },
        c,
      );
      return { deleted: true };
    });
  }

  /** Server-side evaluation after a scan; returns the number of new alert events. */
  async evaluate(scanId: string): Promise<number> {
    const alerts = await this.db.query<{ id: string; user_id: string; rule: AlertRule }>(
      'SELECT id, user_id, rule FROM intel_alerts WHERE active',
    );
    if (!alerts.length) return 0;
    const trends = await this.db.query<{
      symbol: string;
      kind: string;
      score: number;
      region: string;
      asset_class: string;
    }>(
      `SELECT t.symbol, t.kind, t.score, v.region, i.asset_class
         FROM intel_trends t JOIN instruments i ON i.symbol = t.symbol JOIN venues v ON v.mic = i.venue
        WHERE t.scan_id = $1`,
      [scanId],
    );
    let n = 0;
    for (const a of alerts) {
      const rule = AlertRuleSchema.safeParse(a.rule);
      if (!rule.success) continue;
      const r = rule.data;
      for (const t of trends) {
        const region = radarRegion(t.region);
        const sector = sectorOf(t.symbol, t.asset_class as (typeof ASSET_CLASSES)[number]);
        if (!(r.trendKinds as readonly string[]).includes(t.kind)) continue;
        if (t.score < r.minScore) continue;
        if (r.region && r.region !== region) continue;
        if (r.assetClass && r.assetClass !== t.asset_class) continue;
        if (r.sector && r.sector !== sector) continue;
        if (r.symbol && r.symbol !== t.symbol) continue;
        const ins = await this.db.query(
          `INSERT INTO intel_alert_events (alert_id, user_id, symbol, scan_id, detail)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
          [
            a.id,
            a.user_id,
            t.symbol,
            scanId,
            JSON.stringify({ kind: t.kind, score: t.score, region, simulated: true }),
          ],
        );
        n += ins.length;
      }
    }
    return n;
  }
}
