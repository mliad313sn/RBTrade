import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { depthChannel, quoteChannel } from '@kora/domain';
import { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { busChannel, MD_CONFIG, type MdConfig } from '../market-data/md-config';
import { MarketViewService } from './market-view.service';
import { OmsService } from './oms.service';
import { PaperEngineService } from './paper-engine.service';
import { TRADING_CONFIG, type TradingConfig } from './trading-config';
import { TradingRegistryService } from './trading-registry.service';
import type { OrderRow } from './trading.types';

/**
 * Matching loop: subscribes to quote/depth updates of every symbol with working orders (Redis bus,
 * not conflated), works those orders per account under the account lock, and runs a periodic sweep
 * for held orders (market became safe again), missed events, expiries (DAY/GTD) and the daily roll.
 */
@Injectable()
export class EngineLoopService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('EngineLoop');
  private sub: Redis | null = null;
  private readonly subscribed = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private lastRollDate: string | null = null;

  constructor(
    @Inject(TRADING_CONFIG) private readonly cfg: TradingConfig,
    @Inject(APP_CONFIG) private readonly app: AppConfig,
    @Inject(MD_CONFIG) private readonly md: MdConfig,
    private readonly db: DbService,
    private readonly oms: OmsService,
    private readonly engine: PaperEngineService,
    private readonly registry: TradingRegistryService,
    private readonly market: MarketViewService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.engineEnabled) return;
    this.sub = new Redis(this.app.redisUrl, { maxRetriesPerRequest: null });
    this.sub.on('error', (e) => this.log.warn(`redis: ${e.message}`));
    this.sub.on('message', (ch: string) => {
      const name = ch.slice(this.md.prefix.length);
      const sym = name.slice(name.indexOf(':') + 1);
      void this.matchSymbol(sym);
    });
    this.timer = setInterval(() => void this.sweep(), this.cfg.sweepMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.sub?.disconnect();
    await Promise.allSettled([...this.running.values()]);
  }

  /** Works every open order on `symbol` (single-flight per symbol; reruns once if poked meanwhile). */
  matchSymbol(symbol: string): Promise<void> {
    const current = this.running.get(symbol);
    if (current) {
      this.dirty.add(symbol);
      return current;
    }
    const run = (async () => {
      try {
        do {
          this.dirty.delete(symbol);
          await this.matchOnce(symbol);
        } while (this.dirty.has(symbol));
      } catch (e) {
        this.log.error(`match ${symbol}: ${(e as Error).message}`);
      } finally {
        this.running.delete(symbol);
      }
    })();
    this.running.set(symbol, run);
    return run;
  }

  private async matchOnce(symbol: string, now = Date.now()): Promise<void> {
    const accounts = await this.db.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM orders WHERE symbol = $1 AND status IN ('working','partially_filled') AND exec_type <> 'none'`,
      [symbol],
    );
    if (!accounts.length) return;
    const inst = await this.registry.get(symbol);
    const snap = await this.market.snapshot(inst, now);
    if (snap.safety !== 'ok' || snap.session !== 'open') return;
    for (const { account_id } of accounts) {
      await this.oms.withAccount(
        account_id,
        async (tx) => {
          const orders = await tx.c.query<OrderRow>(
            `SELECT * FROM orders WHERE account_id = $1 AND symbol = $2 AND status IN ('working','partially_filled') AND exec_type <> 'none'
             ORDER BY created_at, id FOR UPDATE`,
            [account_id, symbol],
          );
          for (const o of orders.rows) {
            // Re-read: an earlier order in this pass may have cancelled or resized this one.
            const fresh = await tx.c.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [o.id]);
            await this.engine.work(tx, fresh.rows[0]!, snap, inst, false);
          }
        },
        now,
      );
    }
  }

  /** Expires DAY/GTD orders whose time has come. */
  async expireDue(now = Date.now()): Promise<number> {
    const due = await this.db.query<{ account_id: string; id: string }>(
      `SELECT account_id, id FROM orders WHERE status IN ('accepted','working','partially_filled') AND expire_at IS NOT NULL AND expire_at <= $1 ORDER BY account_id`,
      [new Date(now)],
    );
    const byAccount = new Map<string, string[]>();
    for (const d of due)
      byAccount.set(d.account_id, [...(byAccount.get(d.account_id) ?? []), d.id]);
    let n = 0;
    for (const [accountId, ids] of byAccount) {
      await this.oms.withAccount(
        accountId,
        async (tx) => {
          const rows = await tx.c.query<OrderRow>(
            'SELECT * FROM orders WHERE id = ANY($1) FOR UPDATE',
            [ids],
          );
          for (const r of rows.rows) {
            const done = await this.engine.expire(
              tx,
              r,
              r.tif === 'day' ? 'day_end' : 'good_till_date',
            );
            if (done.status === 'expired') n += 1;
          }
        },
        now,
      );
    }
    return n;
  }

  /** Daily roll: overnight funding once per account per roll date (after the roll hour, UTC). */
  async rollover(now = Date.now()): Promise<number> {
    const d = new Date(now);
    if (d.getUTCHours() < this.cfg.rollUtcHour) return 0;
    const rollDate = d.toISOString().slice(0, 10);
    const accounts = await this.db.query<{ account_id: string }>(
      `SELECT DISTINCT p.account_id FROM positions p WHERE p.qty <> 0
       AND NOT EXISTS (SELECT 1 FROM account_rolls r WHERE r.account_id = p.account_id AND r.roll_date = $1::date)`,
      [rollDate],
    );
    let n = 0;
    for (const { account_id } of accounts)
      n += await this.oms.withAccount(
        account_id,
        (tx) => this.engine.rollAccount(tx, rollDate),
        now,
      );
    this.lastRollDate = rollDate;
    return n;
  }

  async sweep(now = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.syncSubscriptions();
      await this.expireDue(now);
      const symbols = await this.db.query<{ symbol: string }>(
        `SELECT DISTINCT symbol FROM orders WHERE status IN ('working','partially_filled') AND exec_type <> 'none'`,
      );
      for (const { symbol } of symbols) await this.matchSymbol(symbol);
      if (this.lastRollDate !== new Date(now).toISOString().slice(0, 10)) await this.rollover(now);
    } catch (e) {
      this.log.warn(`sweep: ${(e as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async syncSubscriptions(): Promise<void> {
    if (!this.sub) return;
    const rows = await this.db.query<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM orders WHERE status IN ('working','partially_filled')`,
    );
    const want = new Set(rows.map((r) => r.symbol));
    const add = [...want].filter((s) => !this.subscribed.has(s));
    const drop = [...this.subscribed].filter((s) => !want.has(s));
    if (add.length)
      await this.sub.subscribe(
        ...add.flatMap((s) => [
          busChannel(this.md, quoteChannel(s)),
          busChannel(this.md, depthChannel(s)),
        ]),
      );
    if (drop.length)
      await this.sub.unsubscribe(
        ...drop.flatMap((s) => [
          busChannel(this.md, quoteChannel(s)),
          busChannel(this.md, depthChannel(s)),
        ]),
      );
    for (const s of add) this.subscribed.add(s);
    for (const s of drop) this.subscribed.delete(s);
  }
}
