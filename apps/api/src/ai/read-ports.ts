import { Injectable } from '@nestjs/common';
import type { PreviewOrderRequest, Role } from '@kora/domain';

import { RobotsService } from '../robots/robots.service';
import { BacktestsService } from '../strategies/backtests.service';
import { StrategiesService } from '../strategies/strategies.service';
import { AccountsService } from '../trading/accounts.service';
import { OmsService } from '../trading/oms.service';

/**
 * The ONLY file in `apps/api/src/ai` allowed to touch the accounts, OMS, robot and strategy services. It
 * exposes read-only functions (plus the pure strategy validator). There is deliberately no way to
 * reach `OmsService.submit/amend/cancel`, robot start/pause/promote or `StrategiesService.newVersion`
 * from the copilot, and no way to reach `AccountsService.updateSettings` or any other account write
 * (IRTC R6-02); `ai.static.test.ts` fails the build if that changes.
 */
@Injectable()
export class AiReadPorts {
  constructor(
    private readonly accounts: AccountsService,
    private readonly oms: OmsService,
    private readonly robots: RobotsService,
    private readonly strategies: StrategiesService,
    private readonly backtests: BacktestsService,
  ) {}

  /**
   * The caller's PAPER account summary (equity, margin, P&L, limits). `ensure` only creates the paper
   * account on first use, exactly like `GET /accounts/me`; it never changes an existing account.
   */
  async accountView(userId: string) {
    const account = await this.accounts.ensure(userId);
    return { account, view: await this.accounts.view(account) };
  }

  /** The caller's open positions, marked to market. */
  async positions(userId: string) {
    const account = await this.accounts.ensure(userId);
    return { account, positions: await this.accounts.positionsView(account) };
  }

  /** Read-only order preview (costs, margin, loss at stop, risk rules). Places nothing. */
  previewOrder(userId: string, roles: Role[], req: PreviewOrderRequest) {
    return this.oms.preview(userId, roles, req);
  }

  robotList(userId: string) {
    return this.robots.list(userId);
  }

  robotDetail(userId: string, roles: Role[], robotId: string) {
    return this.robots.detail(userId, roles, robotId);
  }

  robotSignals(userId: string, roles: Role[], robotId: string, limit: number) {
    return this.robots.signals(userId, roles, robotId, limit);
  }

  signalFeatures(userId: string, roles: Role[], signalId: string) {
    return this.robots.signalFeatures(userId, roles, signalId);
  }

  strategy(userId: string, roles: Role[], strategyId: string) {
    return this.strategies.get(userId, roles, strategyId);
  }

  /** Same code as POST /strategies/validate: schema, semantics, registry, content hash. Stores nothing. */
  validateStrategy(definition: unknown) {
    return this.strategies.validate(definition);
  }

  latestBacktest(versionId: string) {
    return this.backtests.latestBacktest(versionId);
  }
}
