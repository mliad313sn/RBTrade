import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { AccountsService } from './accounts.service';
import { TradingEventsService } from './trading-events.service';
import { toOrderDto, type ChangeSet } from './trading.types';

const COALESCE_MS = 50;

/**
 * Publishes committed changes: order updates immediately (batched per transaction), account and
 * position snapshots coalesced per account (one valuation per 50 ms burst).
 */
@Injectable()
export class TradingPublisher implements OnModuleDestroy {
  private readonly log = new Logger('TradingPublisher');
  private readonly pendingAccounts = new Set<string>();
  private readonly pendingPositions = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly events: TradingEventsService,
    private readonly accounts: AccountsService,
  ) {}

  publish(changes: ChangeSet): void {
    const byAccount = new Map<string, ReturnType<typeof toOrderDto>[]>();
    for (const o of changes.orders.values()) {
      const list = byAccount.get(o.account_id) ?? [];
      list.push(toOrderDto(o));
      byAccount.set(o.account_id, list);
    }
    for (const [id, list] of byAccount) this.events.orders(id, list);
    for (const id of changes.accounts) this.pendingAccounts.add(id);
    for (const id of changes.positions) this.pendingPositions.add(id);
    if (!this.timer && (this.pendingAccounts.size || this.pendingPositions.size)) {
      this.timer = setTimeout(() => void this.flush(), COALESCE_MS);
      this.timer.unref();
    }
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const accounts = [...this.pendingAccounts];
    const positions = new Set(this.pendingPositions);
    this.pendingAccounts.clear();
    this.pendingPositions.clear();
    for (const id of accounts) {
      try {
        const a = await this.accounts.byId(id);
        if (!a) continue;
        // One valuation serves both snapshots (goal 10 load finding: it was computed twice).
        const v = await this.accounts.value(a);
        this.events.account(id, await this.accounts.view(a, undefined, v));
        if (positions.has(id)) this.events.positions(id, await this.accounts.positionsView(a, undefined, v));
      } catch (e) {
        this.log.warn(`publish ${id}: ${(e as Error).message}`);
      }
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
