import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { RISK_ALERTS_CHANNEL } from '@kora/domain';
import { Redis } from 'ioredis';
import { Client } from 'pg';

import { OpsMetrics } from '../observability/ops-metrics.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { busChannel, MD_CONFIG, type MdConfig } from '../market-data/md-config';
import { GOVERNANCE_CONFIG, type GovernanceConfig } from './governance-config';
import { alertView, type AlertRow } from './risk-console.service';

/**
 * Relays new alerts to the risk console in real time (goal 09): `alerts` INSERT → trigger
 * `pg_notify('kora_alerts', id)` (delivered on commit) → this LISTENer → Redis bus channel
 * `risk:alerts` → the WS gateway (risk officers/admins). Every api process listens; a Redis
 * `SET NX` on the alert id makes exactly one of them publish. Reconnects with back-off; the console
 * also polls REST every 5 s as the fallback.
 */
@Injectable()
export class AlertsBridgeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('AlertsBridge');
  private client: Client | null = null;
  private redis: Redis | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;
  private attempt = 0;
  readonly stats = { received: 0, published: 0, duplicates: 0 };

  constructor(
    @Inject(APP_CONFIG) private readonly app: AppConfig,
    @Inject(MD_CONFIG) private readonly md: MdConfig,
    @Inject(GOVERNANCE_CONFIG) private readonly cfg: GovernanceConfig,
    private readonly db: DbService,
    @Optional() private readonly metrics?: OpsMetrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.alertRelay) return;
    this.redis = new Redis(this.app.redisUrl, { maxRetriesPerRequest: 2 });
    this.redis.on('error', (e) => this.log.warn(`redis: ${e.message}`));
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const c = new Client({ connectionString: this.app.databaseUrl, application_name: 'kora-alerts-bridge' });
    c.on('error', (e) => {
      this.log.warn(`listener: ${e.message}`);
      this.reconnect();
    });
    c.on('end', () => this.reconnect());
    c.on('notification', (n) => {
      if (n.channel === 'kora_alerts' && n.payload) void this.relay(n.payload).catch((e: Error) => this.log.warn(e.message));
    });
    try {
      await c.connect();
      await c.query('LISTEN kora_alerts');
      this.client = c;
      this.attempt = 0;
    } catch (e) {
      this.log.warn(`listen failed: ${(e as Error).message}`);
      await c.end().catch(() => undefined);
      this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.stopped || this.retry) return;
    this.client = null;
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
    this.retry.unref();
  }

  private async relay(id: string): Promise<void> {
    this.stats.received += 1;
    const first = await this.redis!.set(`${this.md.prefix}risk-alert:${id}`, '1', 'EX', 300, 'NX');
    if (first !== 'OK') {
      this.stats.duplicates += 1;
      this.metrics?.alertRelay.inc({ result: 'duplicate' });
      return;
    }
    const rows = await this.db.query<AlertRow>('SELECT * FROM alerts WHERE id = $1', [id]);
    if (!rows[0]) return;
    await this.redis!.publish(
      busChannel(this.md, RISK_ALERTS_CHANNEL),
      JSON.stringify({ type: 'risk_alert', alert: alertView(rows[0]), ts: Date.now() }),
    );
    this.stats.published += 1;
    this.metrics?.alertRelay.inc({ result: 'published' });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client?.end().catch(() => undefined);
    this.redis?.disconnect();
  }
}
