import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../config/config';
import { ROBOT_CONTROL_CHANNEL } from '../trading/trading-events.service';

/** Redis key the bot runner refreshes every heartbeat for each robot it runs (value: epoch ms). */
export const heartbeatKey = (robotId: string): string => `kora:robots:hb:${robotId}`;

export interface RobotControlMessage {
  action: 'halt' | 'resume' | 'sync';
  accountId: string;
  robotId?: string;
  status?: string;
  scope?: string | null;
  reason?: string | null;
  auditEventId?: string;
  ts?: number;
}

/**
 * Robot control plane on Redis: publishes `sync` messages on the goal 03 `kora:ctl:robots` channel
 * (next to the kill switch's `halt`/`resume`) so the runner picks up starts and pauses at once, and
 * reads the runner's heartbeats.
 */
@Injectable()
export class RobotControlService implements OnModuleDestroy {
  private readonly log = new Logger('RobotControl');
  private client: Redis | null = null;

  constructor(@Inject(APP_CONFIG) private readonly app: AppConfig) {}

  redis(): Redis {
    if (!this.client) {
      this.client = new Redis(this.app.redisUrl, { maxRetriesPerRequest: 2 });
      this.client.on('error', (e) => this.log.warn(`redis: ${e.message}`));
    }
    return this.client;
  }

  subscriber(): Redis {
    const r = new Redis(this.app.redisUrl, { maxRetriesPerRequest: null });
    r.on('error', (e) => this.log.warn(`redis: ${e.message}`));
    return r;
  }

  sync(accountId: string, robotId: string, status: string): void {
    const msg: RobotControlMessage = { action: 'sync', accountId, robotId, status, ts: Date.now() };
    this.redis()
      .publish(ROBOT_CONTROL_CHANNEL, JSON.stringify(msg))
      .catch(() => undefined);
  }

  async heartbeats(robotIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!robotIds.length) return out;
    const vals = await this.redis().mget(robotIds.map(heartbeatKey));
    robotIds.forEach((id, i) => {
      const v = Number(vals[i]);
      if (Number.isFinite(v) && v > 0) out.set(id, v);
    });
    return out;
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.disconnect();
  }
}
