import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { dec, type Decimal, type Fill } from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import {
  PAPER_FIXTURE_LABEL,
  PAPER_FIXTURE_STARTING_CAPITAL,
  paperFixtureFills,
} from './paper-fixture';
import { DbService } from '../db/db.service';
import { AccountsService } from '../trading/accounts.service';
import { FxService } from '../trading/fx.service';
import { TradingRegistryService } from '../trading/trading-registry.service';
import { QuantClient } from './quant.client';
import {
  FromTradesRequestSchema,
  PaperProjectRequestSchema,
  ProjectRequestSchema,
  type FromTradesRequest,
  type PaperAnalyticsMeta,
  type PaperProjectRequest,
  type ProjectRequest,
  type SimResultMeta,
} from './sim.schemas';

/** Per-IP runs per minute on simulation endpoints (KORA_SIM_RATE_LIMIT, read per request). */
const simThrottle = () => ({
  default: { limit: () => Number(process.env.KORA_SIM_RATE_LIMIT ?? 60) || 60, ttl: 60_000 },
});

const FIXTURE_SOURCE = {
  kind: 'fixture' as const,
  label: PAPER_FIXTURE_LABEL,
  simulated: true as const,
};

type PaperSource =
  | typeof FIXTURE_SOURCE
  | {
      kind: 'paper_account';
      label: string;
      simulated: true;
      accountId: string;
      fills: number;
      currency: string;
    };

/**
 * Gain simulator (goal 05). Validates with zod, forwards to the quant service, audits every run.
 * All roles may run simulations; nothing here touches orders or money.
 */
@ApiTags('simulator')
@Controller('sim')
export class SimController {
  constructor(
    private readonly quant: QuantClient,
    private readonly audit: AuditService,
    private readonly db: DbService,
    private readonly accounts: AccountsService,
    private readonly registry: TradingRegistryService,
    private readonly fx: FxService,
  ) {}

  private async recordRun(
    p: Principal,
    action: string,
    result: SimResultMeta,
    extra: Record<string, string | number | boolean>,
  ) {
    const event = await this.audit.record({
      actorId: p.sub,
      actorType: 'user',
      action,
      entity: 'simulation',
      entityId: result.inputHash,
      payload: {
        kind: result.kind,
        inputHash: result.inputHash,
        cache: result.cache,
        paths: result.paths,
        tradesPerPath: result.tradesPerPath,
        realityChecks: result.realityChecks.map((c) => c.code).join(',') || 'none',
        environment: 'PAPER',
        ...extra,
      },
    });
    return event.id;
  }

  @Post('project')
  @HttpCode(200)
  @Throttle(simThrottle())
  @ApiOperation({
    summary: 'Monte Carlo projection of a trading edge (costs included). SIMULATED. Audited.',
  })
  @ApiBody({ schema: openApiSchema(ProjectRequestSchema) })
  async project(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(ProjectRequestSchema)) body: ProjectRequest,
  ) {
    const result = await this.quant.post<SimResultMeta>('/mc/project', body);
    const auditEventId = await this.recordRun(p, 'sim.projection_run', result, {
      sizingModel: body.sizingModel,
      seed: String(body.seed),
      stressEdgeCutPct: String(body.stressEdgeCutPct),
      fatTailProbPct: String(body.fatTailProbPct),
    });
    return { ...result, auditEventId };
  }

  @Post('from-trades')
  @HttpCode(200)
  @Throttle(simThrottle())
  @ApiOperation({
    summary: 'Block-bootstrap projection of a trade list (backtest or paper). SIMULATED. Audited.',
  })
  @ApiBody({ schema: openApiSchema(FromTradesRequestSchema) })
  async fromTrades(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(FromTradesRequestSchema)) body: FromTradesRequest,
  ) {
    const result = await this.quant.post<SimResultMeta>('/mc/from-trades', body);
    const auditEventId = await this.recordRun(p, 'sim.bootstrap_run', result, {
      source: body.source,
      importedTrades: body.trades.length,
      seed: String(body.seed),
    });
    return { ...result, auditEventId };
  }

  /**
   * B-501: the account's real paper fills (goal 03 engine). Fees are the base-currency commission
   * plus FX conversion; the per-symbol multiplier is the registry price multiplier times the current
   * quote → base rate, so P&L is in the account currency. Accounts with no fills yet keep the
   * clearly labelled SIMULATED fixture so the simulator stays demonstrable.
   */
  private async paperAnalytics(
    p: Principal,
  ): Promise<{ source: PaperSource; analytics: PaperAnalyticsMeta }> {
    const account = await this.accounts.ensure(p.sub);
    const rows = await this.db.query<{
      id: string;
      order_id: string;
      symbol: string;
      side: 'buy' | 'sell';
      qty: string;
      price: string;
      commission: string;
      fx_conversion_cost: string;
      slippage: string;
      fx_rate: string;
      ts: Date;
    }>(
      'SELECT id, order_id, symbol, side, qty::text, price::text, commission::text, fx_conversion_cost::text, slippage::text, fx_rate::text, ts FROM fills WHERE account_id = $1 ORDER BY ts, id LIMIT 100000',
      [account.id],
    );
    if (rows.length === 0) {
      const analytics = await this.quant.post<PaperAnalyticsMeta>(
        '/analytics/paper?simulated_source=true',
        {
          startingCapital: PAPER_FIXTURE_STARTING_CAPITAL,
          fills: paperFixtureFills(),
        },
      );
      return { source: FIXTURE_SOURCE, analytics };
    }
    const multipliers: Record<string, string> = {};
    for (const sym of new Set(rows.map((r) => r.symbol))) {
      const inst = await this.registry.get(sym);
      const rate = await this.fx.rate(inst.spec.quoteCcy, account.base_currency);
      multipliers[sym] = inst.multiplier
        .mul(rate?.rate ?? dec(rows.find((r) => r.symbol === sym)!.fx_rate))
        .toDecimalPlaces(12)
        .toFixed();
    }
    const q = (v: Decimal) => v.toDecimalPlaces(10).toFixed();
    const fills: Fill[] = rows.map((r) => {
      const slipCost = dec(r.slippage).mul(dec(r.qty)).mul(dec(multipliers[r.symbol]!));
      return {
        id: r.id,
        orderId: r.order_id,
        symbol: r.symbol,
        side: r.side,
        qty: r.qty,
        price: r.price,
        fee: q(dec(r.commission).add(dec(r.fx_conversion_cost))),
        slippage: q(slipCost.gt(0) ? slipCost : dec(0)),
        ts: r.ts.toISOString(),
      };
    });
    const analytics = await this.quant.post<PaperAnalyticsMeta>('/analytics/paper', {
      startingCapital: dec(account.starting_cash).toFixed(),
      fills,
      contractMultipliers: multipliers,
    });
    return {
      source: {
        kind: 'paper_account',
        label: `Your paper account · ${rows.length} fills (PAPER, SIMULATED market data)`,
        simulated: true,
        accountId: account.id,
        fills: rows.length,
        currency: account.base_currency,
      },
      analytics,
    };
  }

  @Get('paper/analytics')
  @Throttle(simThrottle())
  @ApiOperation({
    summary: 'Paper-account analytics (SIMULATED fixture fills until the goal 03 paper engine).',
  })
  async paper(@CurrentPrincipal() p: Principal) {
    return this.paperAnalytics(p);
  }

  @Post('paper/project')
  @HttpCode(200)
  @Throttle(simThrottle())
  @ApiOperation({
    summary:
      '"Project from my paper results": analytics, then a block bootstrap of the paper trades. Audited.',
  })
  @ApiBody({ schema: openApiSchema(PaperProjectRequestSchema) })
  async paperProject(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(PaperProjectRequestSchema)) body: PaperProjectRequest,
  ) {
    const { source, analytics } = await this.paperAnalytics(p);
    if (analytics.tradeReturnsPct.length < 2) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'not_enough_trades',
        message: 'The paper account needs at least two closed trades before it can be projected.',
      });
    }
    const request: FromTradesRequest = {
      ...body,
      startingCapital: Number(analytics.endingEquity),
      withdrawals: { perPeriod: 0, oneOff: [] },
      trades: analytics.tradeReturnsPct,
      tradeUnit: 'pct_return',
      riskPct: 1,
      extraCostPerTradeR: 0,
      source: 'paper',
    };
    const projection = await this.quant.post<SimResultMeta>('/mc/from-trades', request);
    const auditEventId = await this.recordRun(p, 'sim.paper_projection_run', projection, {
      source: source.kind === 'fixture' ? 'paper_fixture' : 'paper_account',
      importedTrades: analytics.tradeReturnsPct.length,
      seed: String(body.seed),
    });
    return { source, analytics, projection: { ...projection, auditEventId } };
  }
}
