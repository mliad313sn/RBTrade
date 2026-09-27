import { Injectable, type OnModuleInit } from '@nestjs/common';

import { DbService } from '../db/db.service';
import { OpsMetrics } from './ops-metrics.service';

/** Scrape-time governance gauges (goal 09 hand-over to goal 10, B-916). One small query per scrape. */
@Injectable()
export class GovernanceHealthMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: OpsMetrics,
    private readonly db: DbService,
  ) {}

  onModuleInit(): void {
    this.metrics.onScrape(async () => {
      const rows = await this.db.query<Record<string, string | null>>(`
        SELECT
          (SELECT count(*) FROM four_eyes_requests WHERE status = 'pending')::text AS four_eyes_pending,
          (SELECT count(*) FROM alerts WHERE severity = 'critical' AND acknowledged_at IS NULL)::text AS alerts_open_critical,
          (SELECT extract(epoch FROM max(anchored_at)) FROM audit_anchors)::text AS anchor_last_success_ts,
          (SELECT extract(epoch FROM max(finished_at)) FROM backup_runs WHERE ok AND kind = 'restore_test')::text AS backup_last_success_ts,
          (SELECT extract(epoch FROM max(started_at)) FROM reconciliation_runs)::text AS reconciliation_last_run_ts,
          (SELECT count(*) FROM alerts WHERE kind = 'reconciliation.mismatch' AND acknowledged_at IS NULL)::text AS reconciliation_breaks_open,
          (SELECT count(*) FROM incidents WHERE priority IN ('P1', 'P2') AND status <> 'closed')::text AS incidents_open_p1p2`);
      for (const [metric, v] of Object.entries(rows[0] ?? {})) {
        if (v !== null) this.metrics.governance.set({ metric }, Number(v));
      }
    });
  }
}
