import { Body, Controller, Get, HttpCode, Post, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { PAPER_FIXTURE_LABEL, PAPER_FIXTURE_STARTING_CAPITAL, paperFixtureFills } from './paper-fixture';
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

const PAPER_SOURCE = { kind: 'fixture' as const, label: PAPER_FIXTURE_LABEL, simulated: true as const };

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
  ) {}

  private async recordRun(p: Principal, action: string, result: SimResultMeta, extra: Record<string, string | number | boolean>) {
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
  @ApiOperation({ summary: 'Monte Carlo projection of a trading edge (costs included). SIMULATED. Audited.' })
  @ApiBody({ schema: openApiSchema(ProjectRequestSchema) })
  async project(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(ProjectRequestSchema)) body: ProjectRequest) {
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
  @ApiOperation({ summary: 'Block-bootstrap projection of a trade list (backtest or paper). SIMULATED. Audited.' })
  @ApiBody({ schema: openApiSchema(FromTradesRequestSchema) })
  async fromTrades(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(FromTradesRequestSchema)) body: FromTradesRequest) {
    const result = await this.quant.post<SimResultMeta>('/mc/from-trades', body);
    const auditEventId = await this.recordRun(p, 'sim.bootstrap_run', result, {
      source: body.source,
      importedTrades: body.trades.length,
      seed: String(body.seed),
    });
    return { ...result, auditEventId };
  }

  private paperAnalytics() {
    return this.quant.post<PaperAnalyticsMeta>('/analytics/paper?simulated_source=true', {
      startingCapital: PAPER_FIXTURE_STARTING_CAPITAL,
      fills: paperFixtureFills(),
    });
  }

  @Get('paper/analytics')
  @Throttle(simThrottle())
  @ApiOperation({ summary: 'Paper-account analytics (SIMULATED fixture fills until the goal 03 paper engine).' })
  async paper() {
    return { source: PAPER_SOURCE, analytics: await this.paperAnalytics() };
  }

  @Post('paper/project')
  @HttpCode(200)
  @Throttle(simThrottle())
  @ApiOperation({ summary: '"Project from my paper results": analytics, then a block bootstrap of the paper trades. Audited.' })
  @ApiBody({ schema: openApiSchema(PaperProjectRequestSchema) })
  async paperProject(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(PaperProjectRequestSchema)) body: PaperProjectRequest) {
    const analytics = await this.paperAnalytics();
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
      source: 'paper_fixture',
      importedTrades: analytics.tradeReturnsPct.length,
      seed: String(body.seed),
    });
    return { source: PAPER_SOURCE, analytics, projection: { ...projection, auditEventId } };
  }
}
