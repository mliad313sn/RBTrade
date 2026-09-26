import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BacktestRequestSchema,
  dec,
  Decimal,
  formatAmount,
  noviceTemplates,
  RobotLimitsSchema,
  type RobotLimits,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { RobotsService } from '../robots/robots.service';
import { BacktestsService } from '../strategies/backtests.service';
import { StrategiesService } from '../strategies/strategies.service';
import { AccountsService } from '../trading/accounts.service';
import { TradingRegistryService } from '../trading/trading-registry.service';
import { NOVICE_CONFIG, type NoviceConfig } from './novice-config';
import { NoviceService, type Caller } from './novice.service';

interface OosRow {
  oos: Record<string, number | null> | null;
  created_at: Date;
  run_id: string;
}

/**
 * Auto-invest for novices (goal 08 §6, decision on B-614): ready-made robots only, PAPER only, through
 * this guarded path instead of the builder API. The template definition is used as-is; allocation and
 * robot limits are capped from the user's own loss limits; results shown are out-of-sample test
 * results and the user's own paper results, never in-sample numbers.
 */
@Injectable()
export class AutoInvestService {
  private readonly log = new Logger('AutoInvest');

  constructor(
    @Inject(NOVICE_CONFIG) private readonly cfg: NoviceConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly registry: TradingRegistryService,
    private readonly strategies: StrategiesService,
    private readonly backtests: BacktestsService,
    private readonly robots: RobotsService,
    private readonly novice: NoviceService,
  ) {}

  private async catalogue() {
    const classes = new Map<string, string>();
    for (const t of noviceTemplates())
      for (const s of t.symbols) {
        const inst = await this.registry.find(s);
        if (inst) classes.set(s, inst.spec.assetClass);
      }
    return noviceTemplates((s) => classes.get(s) ?? 'cfd');
  }

  /** Latest out-of-sample result of a backtest of exactly this template (any run of the same content). */
  private async oos(definition: unknown) {
    const v = await this.strategies.validate(definition);
    if (!v.contentHash) return null;
    const r = await this.db.query<OosRow>(
      `SELECT br.id AS run_id, br.created_at, br.result->'metrics'->'outOfSample' AS oos FROM backtest_runs br
       JOIN strategy_versions sv ON sv.id = br.version_id
       WHERE sv.content_hash = $1 AND br.kind = 'backtest' ORDER BY br.created_at DESC LIMIT 1`,
      [v.contentHash],
    );
    const row = r[0];
    if (!row?.oos) return null;
    const o = row.oos;
    const pct = (x: number | null | undefined, k = 100) =>
      typeof x === 'number' ? (x * k).toFixed(2) : null;
    return {
      segment: 'out_of_sample' as const,
      runId: row.run_id,
      testedAt: row.created_at.toISOString(),
      trades: typeof o.trades === 'number' ? o.trades : 0,
      returnPct:
        typeof o.netPnl === 'number' && typeof o.startEquity === 'number' && o.startEquity > 0
          ? ((o.netPnl / o.startEquity) * 100).toFixed(2)
          : null,
      worstDipPct: pct(
        o.maxDrawdown === null || o.maxDrawdown === undefined ? null : -o.maxDrawdown,
      ),
      winRatePct: pct(o.winRate),
      days: typeof o.days === 'number' ? Math.round(o.days) : null,
      simulated: true,
    };
  }

  private bounds(equity: Decimal, ccy: string) {
    return {
      min: formatAmount(equity.mul(dec(this.cfg.autoInvestMinPct)).div(100), ccy),
      max: formatAmount(equity.mul(dec(this.cfg.autoInvestMaxPct)).div(100), ccy),
    };
  }

  async list(c: Caller) {
    const account = await this.accounts.ensure(c.sub);
    const v = await this.accounts.value(account);
    const mine = (await this.robots.list(c.sub)).robots.filter(
      (r) => r.origin === 'novice_template',
    );
    const templates = [];
    for (const t of await this.catalogue()) {
      const robot = mine.filter((r) => r.templateId === t.id).at(-1) ?? null;
      templates.push({
        id: t.id,
        riskLevel: t.riskLevel,
        factors: t.factors,
        symbols: t.symbols,
        timeframe: t.timeframe,
        oos: await this.oos(t.template.definition),
        robot: robot
          ? {
              id: robot.id,
              status: robot.status,
              allocation: robot.allocation,
              equity: robot.equity,
              pnl: robot.pnl,
              openPositions: robot.openPositions,
              startedAt: robot.startedAt,
              pauseReason: robot.pauseReason,
              mode: robot.mode,
            }
          : null,
      });
    }
    return {
      currency: account.base_currency,
      environment: 'PAPER' as const,
      simulated: true,
      amount: this.bounds(v.summary.equity, account.base_currency),
      templates,
      liveAvailable: false,
    };
  }

  private async ownNoviceRobot(c: Caller, id: string) {
    const r = await this.robots.row(id);
    if (!r || r.owner_id !== c.sub || r.origin !== 'novice_template')
      throw new NotFoundException({ error: 'not_found', message: 'Robot not found.' });
    return r;
  }

  private async mustBeFreeToTrade(c: Caller) {
    const account = await this.accounts.ensure(c.sub);
    if (account.trading_halted)
      throw new ConflictException({
        error: 'trading_halted',
        message: 'Trading is stopped by the kill switch. Resume trading first.',
      });
    const v = await this.accounts.value(account);
    const guard = await this.accounts.guardState(account, v);
    if (guard.coolingOff.active)
      throw new ConflictException({
        error: 'cooling_off',
        message: 'Time for a break: robots cannot start today. You can start one again tomorrow.',
        until: guard.coolingOff.until,
      });
    return { account, v };
  }

  async create(c: Caller, body: { templateId: string; amount: string }) {
    if (!(await this.novice.isOnboarded(c.sub)))
      throw new ConflictException({
        error: 'onboarding_required',
        message: 'Finish the short introduction first.',
      });
    const t = (await this.catalogue()).find((x) => x.id === body.templateId);
    if (!t)
      throw new NotFoundException({ error: 'not_found', message: 'Unknown ready-made robot.' });
    const { account, v } = await this.mustBeFreeToTrade(c);
    const ccy = account.base_currency;
    const b = this.bounds(v.summary.equity, ccy);
    const amount = dec(body.amount);
    if (amount.lt(dec(b.min)) || amount.gt(dec(b.max)))
      throw new BadRequestException({
        statusCode: 400,
        error: 'amount_out_of_range',
        message: `Choose an amount between ${b.min} and ${b.max} ${ccy}.`,
        min: b.min,
        max: b.max,
      });
    const active = (await this.robots.list(c.sub)).robots.find(
      (r) => r.origin === 'novice_template' && r.templateId === t.id && r.status !== 'stopped',
    );
    if (active)
      throw new ConflictException({
        error: 'already_added',
        message: 'You already use this robot. Pause or restart it instead.',
        robotId: active.id,
      });
    const limits = this.robotLimits(amount, dec(this.accounts.limits(account).dailyLossLimit), ccy);
    const strategy = await this.strategies.create(c.sub, {
      definition: t.template.definition,
      reason: `Auto-invest: ready-made robot ${t.id} (Novice view, unchanged template)`,
    });
    const versionId = (strategy as { latest?: { id: string } }).latest!.id;
    const robot = await this.robots.create(
      c.sub,
      c.roles,
      {
        name: `${t.template.name} (auto-invest)`.slice(0, 60),
        versionId,
        allocation: formatAmount(amount, ccy),
        limits,
      },
      { origin: 'novice_template', templateId: t.id },
    );
    await this.robots.start(c.sub, robot.id);
    await this.audit.record({
      actorId: c.sub,
      actorType: 'user',
      action: 'novice.autoinvest_started',
      entity: 'robot',
      entityId: robot.id,
      payload: {
        robotId: robot.id,
        templateId: t.id,
        riskLevel: t.riskLevel,
        amount: formatAmount(amount, ccy),
        currency: ccy,
        mode: 'PAPER',
      },
    });
    // Out-of-sample numbers for this template, if none exist yet (best effort, never blocks).
    if (!(await this.oos(t.template.definition)))
      void this.backtests
        .backtest(c.sub, c.roles, BacktestRequestSchema.parse({ versionId }))
        .catch((e: unknown) => this.log.warn(`template test for ${t.id} skipped: ${String(e)}`));
    return this.list(c);
  }

  /** Robot limits for a novice template robot: tighter than the user's own daily loss limit. */
  robotLimits(amount: Decimal, dailyLimit: Decimal, ccy: string): RobotLimits {
    const threePct = amount.mul('0.03');
    const daily = Decimal.max(Decimal.min(threePct, dailyLimit), dec('0.01'));
    return RobotLimitsSchema.parse({
      dailyLoss: formatAmount(daily, ccy),
      weeklyLoss: formatAmount(daily.mul(2), ccy),
      maxDrawdownPct: 10,
      ordersPerMinute: 5,
      grossExposure: 1,
    });
  }

  async pause(c: Caller, id: string) {
    await this.ownNoviceRobot(c, id);
    await this.robots.pause(c.sub, id, 'Paused from Auto-invest');
    return this.list(c);
  }

  async resume(c: Caller, id: string) {
    const r = await this.ownNoviceRobot(c, id);
    if (r.status === 'running') return this.list(c);
    await this.mustBeFreeToTrade(c);
    await this.robots.start(c.sub, id);
    return this.list(c);
  }

  /**
   * Live is never available from the Novice view today: it needs the knowledge check, the goal 06
   * promotion rules (OOS evidence, paper days, four-eyes sign-off, 2FA) and LIVE_TRADING_ENABLED.
   * The refusal is audited with the checklist.
   */
  async goLive(c: Caller, id: string) {
    await this.ownNoviceRobot(c, id);
    const k = await this.novice.knowledgeStatus(c.sub);
    const checklist = [
      { id: 'knowledge_check', ok: k.passed },
      { id: 'promotion_rules', ok: false },
      // LIVE is a Sponsor decision; this path never enables it (master goal: paper first).
      { id: 'live_trading_enabled', ok: false },
    ];
    await this.audit.record({
      actorId: c.sub,
      actorType: 'user',
      action: 'novice.autoinvest_live_refused',
      entity: 'robot',
      entityId: id,
      payload: {
        robotId: id,
        knowledgeCheckPassed: k.passed,
        promotionRulesMet: false,
        liveTradingEnabled: false,
      },
    });
    throw new ForbiddenException({
      error: 'live_not_available',
      message:
        'Real money is not available yet. It needs the 5-question check, the robot promotion rules, and a sign-off.',
      checklist,
    });
  }
}
