import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  BLOCK_CATALOG,
  CreateRobotSchema,
  PromoteSchema,
  RiskSignoffSchema,
  ROBOT_BUILDER_ROLES,
  RobotLimitsUpdateSchema,
  RobotReasonSchema,
  RobotVersionSwitchSchema,
} from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal, Public, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { PromotionService } from './promotion.service';
import { RobotRuntimeService, type SignalResult } from './robot-runtime.service';
import { RobotTrackingService } from './robot-tracking.service';
import { RobotsService } from './robots.service';
import { ServiceTokenGuard } from './service-token.guard';

const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).strict();
const DayBody = z.strictObject({ day: z.iso.date().optional() });

/** Robots (goal 06 §7–9): trader, quant or admin. Novices get 403 (templates only, goal 08). */
@ApiTags('robots')
@Controller('robots')
@Roles(...ROBOT_BUILDER_ROLES)
export class RobotsController {
  constructor(
    private readonly robots: RobotsService,
    private readonly promotion: PromotionService,
    private readonly tracking: RobotTrackingService,
  ) {}

  @Get('builder')
  @ApiOperation({ summary: 'Builder metadata: block catalog. Trader, quant or admin only.' })
  builder() {
    return {
      status: 'ready',
      blocks: BLOCK_CATALOG.map((b) => ({ id: b.id, label: b.label, sections: b.sections })),
    };
  }

  @Get()
  @ApiOperation({ summary: 'My robots with status, equity and P&L (PAPER).' })
  list(@CurrentPrincipal() p: Principal) {
    return this.robots.list(p.sub);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a PAPER robot from a strategy version with per-robot risk limits (audited).',
  })
  @ApiBody({ schema: openApiSchema(CreateRobotSchema) })
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(CreateRobotSchema)) body: z.infer<typeof CreateRobotSchema>,
  ) {
    return this.robots.create(p.sub, p.roles, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Monitor view: book, limit usage, KPIs (IS / OOS / WF / live), tracking error.',
  })
  detail(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.robots.detail(p.sub, p.roles, id);
  }

  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start (paper-run) the robot. Refused while the account is halted.' })
  start(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.robots.start(p.sub, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pause the robot (reason required, audited). Protective stops stay working.',
  })
  @ApiBody({ schema: openApiSchema(RobotReasonSchema) })
  pause(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RobotReasonSchema)) body: { reason: string },
  ) {
    return this.robots.pause(p.sub, id, body.reason);
  }

  @Put(':id/version')
  @ApiOperation({
    summary:
      'Switch the robot to another version of its strategy (paused robots only; audited with both hashes).',
  })
  @ApiBody({ schema: openApiSchema(RobotVersionSwitchSchema) })
  version(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RobotVersionSwitchSchema))
    body: z.infer<typeof RobotVersionSwitchSchema>,
  ) {
    return this.robots.switchVersion(p.sub, id, body.versionId, body.reason);
  }

  @Put(':id/limits')
  @ApiOperation({
    summary: 'Change risk limits (paused robots only). Invalidates the risk sign-off.',
  })
  @ApiBody({ schema: openApiSchema(RobotLimitsUpdateSchema) })
  limits(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RobotLimitsUpdateSchema))
    body: z.infer<typeof RobotLimitsUpdateSchema>,
  ) {
    return this.robots.updateLimits(p.sub, id, body.limits, body.reason);
  }

  @Get(':id/signals')
  @ApiOperation({ summary: 'Decisions with evaluated features and contributions.' })
  signals(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(LimitQuery)) q: z.infer<typeof LimitQuery>,
  ) {
    return this.robots.signals(p.sub, p.roles, id, q.limit);
  }

  @Get(':id/audit')
  @ApiOperation({
    summary: 'Live audit feed: robot, strategy and robot-actor events (hash-chained log).',
  })
  auditFeed(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(LimitQuery)) q: z.infer<typeof LimitQuery>,
  ) {
    return this.robots.auditFeed(p.sub, p.roles, id, q.limit);
  }

  @Post(':id/tracking')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Recompute live-vs-backtest tracking error for a UTC day (default: yesterday).',
  })
  async trackingRun(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(DayBody)) body: { day?: string },
  ) {
    await this.robots.requireOwner(p.sub, id);
    return this.tracking.computeDay(
      id,
      body.day ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    );
  }

  @Get(':id/promotion')
  @ApiOperation({
    summary: 'Promote-to-LIVE checklist with evidence (blocked while LIVE_TRADING_ENABLED=false).',
  })
  promotionView(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.promotion.view(p.sub, p.roles, id);
  }

  @Post(':id/promote')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Request promotion with a TOTP code. Always recorded; refused without every checklist item and while LIVE is disabled.',
  })
  @ApiBody({ schema: openApiSchema(PromoteSchema) })
  promote(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(PromoteSchema)) body: { totpCode: string },
  ) {
    return this.promotion.promote(p.sub, id, body.totpCode);
  }
}

/** Risk officer review of robots (four-eyes sign-off of risk limits). */
@ApiTags('robots')
@Controller('robot-reviews')
@Roles('risk_officer', 'admin')
export class RobotReviewsController {
  constructor(
    private readonly robots: RobotsService,
    private readonly promotion: PromotionService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Robot detail and checklist for a risk review.' })
  async review(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return {
      robot: await this.robots.detail(p.sub, p.roles, id),
      promotion: await this.promotion.view(p.sub, p.roles, id),
    };
  }

  @Post(':id/signoff')
  @ApiOperation({
    summary:
      'Sign the robot’s current risk limits (risk officer, not the owner; bound to the limits hash).',
  })
  @ApiBody({ schema: openApiSchema(RiskSignoffSchema) })
  signoff(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RiskSignoffSchema)) body: z.infer<typeof RiskSignoffSchema>,
  ) {
    return this.promotion.signoff(p.sub, p.roles, id, body);
  }
}

/** Signal features for explanations (goal 07 `get_signal_features`). Owner, risk officer or admin. */
@ApiTags('robots')
@Controller('signals')
export class SignalsController {
  constructor(private readonly robots: RobotsService) {}

  @Get(':id/features')
  @ApiOperation({
    summary: 'Evaluated conditions, operand values and contributions of one robot signal.',
  })
  features(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.robots.signalFeatures(p.sub, p.roles, id);
  }
}

const DecisionBody = z.strictObject({
  symbol: z.string().min(1).max(32),
  barTs: z.number().int().min(0),
  versionId: z.uuid(),
  signal: z.looseObject({
    symbol: z.string(),
    barTs: z.number().int(),
    action: z.enum(['enter_long', 'enter_short', 'exit', 'hold', 'blocked']),
    reason: z.string(),
  }),
});
const ContextQuery = z
  .object({ symbol: z.string().min(1).max(32), barTs: z.coerce.number().int().min(0) })
  .strict();

/**
 * Internal API for the bot runner (B-301). Service-token authenticated; never reachable with a user
 * session. The robot id in the path is resolved to its owner and account on the server.
 */
@ApiTags('internal')
@Controller('internal/robots')
@Public()
@SkipThrottle()
@UseGuards(ServiceTokenGuard)
export class InternalRobotsController {
  constructor(
    private readonly runtime: RobotRuntimeService,
    private readonly tracking: RobotTrackingService,
  ) {}

  @Get('running')
  @ApiOperation({ summary: '[service] Running PAPER robots with symbols and timeframe.' })
  running() {
    return this.runtime.running();
  }

  @Get(':id/context')
  @ApiOperation({
    summary:
      '[service] Point-in-time signal request for a closed bar (bars, position, equity, cost model).',
  })
  context(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(ContextQuery)) q: z.infer<typeof ContextQuery>,
  ) {
    return this.runtime.context(id, q.symbol, q.barTs);
  }

  @Post(':id/decisions')
  @HttpCode(200)
  @ApiOperation({
    summary:
      '[service] Record a decision and act on it through the OMS (robot actor, source robot:{id}).',
  })
  decision(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(DecisionBody)) body: z.infer<typeof DecisionBody>,
  ) {
    return this.runtime.decision(id, { ...body, signal: body.signal as unknown as SignalResult });
  }

  @Post('tracking')
  @HttpCode(200)
  @ApiOperation({ summary: '[service] Daily tracking-error job (default: yesterday, UTC).' })
  trackingAll(@Body(new ZodValidationPipe(DayBody)) body: { day?: string }) {
    return this.tracking.computeAll(body.day);
  }
}
