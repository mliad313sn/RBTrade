import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  BacktestRequestSchema,
  BLOCK_CATALOG,
  CreateStrategySchema,
  CreateVersionSchema,
  OptimiseRequestSchema,
  ROBOT_BUILDER_ROLES,
  SensitivityRequestSchema,
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
  WalkForwardRequestSchema,
  type BacktestRequest,
  type OptimiseRequest,
  type SensitivityRequest,
  type WalkForwardRequest,
} from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { BacktestsService } from './backtests.service';
import { StrategiesService } from './strategies.service';

/** Research runs per client per minute (KORA_BT_RATE_LIMIT, default 30). */
const researchThrottle = () => ({
  default: { limit: () => Number(process.env.KORA_BT_RATE_LIMIT ?? 30) || 30, ttl: 60_000 },
});

const STRATEGY_JSON_SCHEMA = z.toJSONSchema(StrategyDefinitionSchema, { io: 'input' });

const ValidateBody = z.strictObject({ definition: z.unknown() });
const RunsQuery = z
  .object({
    strategyId: z.uuid().optional(),
    kind: z.enum(['backtest', 'walk_forward', 'optimise', 'sensitivity']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const TradesQuery = z.object({ segment: z.enum(['oos', 'is', 'wf']).default('oos') }).strict();

/** Strategy builder API (goal 06). Trader, quant or admin only; novices use the templates API. */
@ApiTags('strategies')
@Controller('strategies')
@Roles(...ROBOT_BUILDER_ROLES)
export class StrategiesController {
  constructor(private readonly strategies: StrategiesService) {}

  @Get('schema')
  @ApiOperation({
    summary: 'JSON Schema of the strategy DSL (kora.strategy v1), from the shared zod schema.',
  })
  schema() {
    return { schema: STRATEGY_JSON_SCHEMA };
  }

  @Get('catalog')
  @ApiOperation({ summary: 'Builder block catalog (chips) and templates.' })
  catalog() {
    return {
      blocks: BLOCK_CATALOG.map((b) => ({
        id: b.id,
        label: b.label,
        description: b.description,
        sections: b.sections,
        params: b.params,
      })),
      templates: STRATEGY_TEMPLATES,
    };
  }

  @Post('validate')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Validation panel: schema + semantic issues (errors and warnings), content hash, warm-up.',
  })
  validate(@Body(new ZodValidationPipe(ValidateBody)) body: { definition: unknown }) {
    return this.strategies.validate(body.definition);
  }

  @Get()
  @ApiOperation({ summary: 'My strategies with their latest version.' })
  list(@CurrentPrincipal() p: Principal) {
    return this.strategies.list(p.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Create a strategy (v1, content-hashed, audited).' })
  @ApiBody({ schema: openApiSchema(CreateStrategySchema) })
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(CreateStrategySchema)) body: z.infer<typeof CreateStrategySchema>,
  ) {
    return this.strategies.create(p.sub, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A strategy with every version and the number of trials recorded.' })
  get(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.strategies.get(p.sub, p.roles, id);
  }

  @Post(':id/versions')
  @ApiOperation({
    summary:
      'New immutable version (author + reason, audited with the parameter diff). Same content → the existing version.',
  })
  @ApiBody({ schema: openApiSchema(CreateVersionSchema) })
  newVersion(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CreateVersionSchema)) body: z.infer<typeof CreateVersionSchema>,
  ) {
    return this.strategies.newVersion(p.sub, p.roles, id, body);
  }
}

/** Research runs (goal 06 §3–6). SIMULATED data, registry cost model, audited, trials counted. */
@ApiTags('strategies')
@Controller('backtests')
@Roles(...ROBOT_BUILDER_ROLES)
export class BacktestsController {
  constructor(private readonly backtests: BacktestsService) {}

  @Post()
  @Throttle(researchThrottle())
  @ApiOperation({
    summary:
      'Backtest a version: IS/OOS split, metrics, warnings, deflated Sharpe with server-counted trials.',
  })
  @ApiBody({ schema: openApiSchema(BacktestRequestSchema) })
  run(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(BacktestRequestSchema)) body: BacktestRequest,
  ) {
    return this.backtests.backtest(p.sub, p.roles, body);
  }

  @Post('walk-forward')
  @Throttle(researchThrottle())
  @ApiOperation({
    summary: 'Anchored or rolling walk-forward, optionally re-optimising each fold in-sample.',
  })
  @ApiBody({ schema: openApiSchema(WalkForwardRequestSchema) })
  walkForward(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(WalkForwardRequestSchema)) body: WalkForwardRequest,
  ) {
    return this.backtests.walkForward(p.sub, p.roles, body);
  }

  @Post('optimise')
  @Throttle(researchThrottle())
  @ApiOperation({
    summary:
      'Grid or random search with a hard cap (KORA_BT_MAX_COMBOS), ranked by out-of-sample Sharpe.',
  })
  @ApiBody({ schema: openApiSchema(OptimiseRequestSchema) })
  optimise(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(OptimiseRequestSchema)) body: OptimiseRequest,
  ) {
    return this.backtests.optimise(p.sub, p.roles, body);
  }

  @Post('sensitivity')
  @Throttle(researchThrottle())
  @ApiOperation({ summary: 'Sensitivity heatmap: out-of-sample Sharpe over two parameters.' })
  @ApiBody({ schema: openApiSchema(SensitivityRequestSchema) })
  sensitivity(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(SensitivityRequestSchema)) body: SensitivityRequest,
  ) {
    return this.backtests.sensitivity(p.sub, p.roles, body);
  }

  @Get()
  @ApiOperation({ summary: 'My research runs (summaries).' })
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(RunsQuery)) q: z.infer<typeof RunsQuery>,
  ) {
    return this.backtests.list(p.sub, p.roles, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A research run with its full result.' })
  get(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.backtests.get(p.sub, p.roles, id);
  }

  @Get(':id/trades')
  @ApiOperation({
    summary:
      'R multiples of the run (OOS by default) for "Send to Monte Carlo" (POST /sim/from-trades).',
  })
  trades(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(TradesQuery)) q: z.infer<typeof TradesQuery>,
  ) {
    return this.backtests.tradeList(p.sub, p.roles, id, q.segment);
  }
}

/**
 * Read-only strategy templates for every signed-in role, including novices (goal 08 builds the
 * Novice auto-invest view on this; the builder itself stays trader/quant/admin only).
 */
@ApiTags('strategies')
@Controller('strategy-templates')
export class StrategyTemplatesController {
  @Get()
  @ApiOperation({
    summary:
      'Strategy templates (plain-language summary, risk level, definition). Any signed-in user.',
  })
  list() {
    return {
      templates: STRATEGY_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        summary: t.summary,
        riskLevel: t.riskLevel,
        symbols: t.definition.universe.symbols,
        timeframe: t.definition.universe.timeframe,
        definition: t.definition,
      })),
      disclaimer:
        'Templates are illustrative starting points, not recommendations. Results are SIMULATED.',
    };
  }
}
