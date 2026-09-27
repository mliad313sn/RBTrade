import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { accountChannel, ordersChannel, positionsChannel } from '@kora/domain';
import { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../config/config';
import { busChannel, lastKey, MD_CONFIG, type MdConfig } from '../market-data/md-config';
import { robotControlChannel } from '../robots/robot-channels';

/**
 * Publishes trading events on the same Redis bus the WebSocket gateway fans out (goal 02), so
 * `orders:{account}`, `positions:{account}` and `account:{account}` reach subscribed clients.
 * Orders are batched per committed transaction and never conflated by the gateway.
 */
@Injectable()
export class TradingEventsService implements OnModuleDestroy {
  private readonly log = new Logger('TradingEvents');
  private pub: Redis | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly app: AppConfig,
    @Inject(MD_CONFIG) private readonly md: MdConfig,
  ) {}

  private client(): Redis {
    if (!this.pub) {
      this.pub = new Redis(this.app.redisUrl, { maxRetriesPerRequest: 2 });
      this.pub.on('error', (e) => this.log.warn(`redis: ${e.message}`));
    }
    return this.pub;
  }

  private send(channel: string, msg: unknown, keepLast: boolean): void {
    const json = JSON.stringify(msg);
    const r = this.client();
    r.publish(busChannel(this.md, channel), json).catch(() => undefined);
    if (keepLast) r.set(lastKey(this.md, channel), json, 'EX', 86_400).catch(() => undefined);
  }

  orders(accountId: string, orders: unknown[]): void {
    if (orders.length)
      this.send(
        ordersChannel(accountId),
        { type: 'orders', accountId, orders, ts: Date.now() },
        true,
      );
  }

  positions(accountId: string, positions: unknown[]): void {
    this.send(
      positionsChannel(accountId),
      { type: 'positions', accountId, positions, ts: Date.now() },
      true,
    );
  }

  account(accountId: string, account: unknown): void {
    this.send(
      accountChannel(accountId),
      { type: 'account', accountId, account, ts: Date.now() },
      true,
    );
  }

  robotControl(msg: {
    action: 'halt' | 'resume';
    accountId: string;
    scope: string | null;
    reason: string | null;
    auditEventId: string;
  }): void {
    this.client()
      .publish(robotControlChannel(), JSON.stringify({ ...msg, ts: Date.now() }))
      .catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.pub?.disconnect();
  }
}
