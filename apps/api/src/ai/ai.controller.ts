import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AUDIT_READ_ALL_ROLES,
  isNoviceOnly,
  PRO_ROLES,
  ROBOT_BUILDER_ROLES,
  SYMBOL_RE,
  TIMEFRAMES,
  type Role,
} from '@kora/domain';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { AiService, type AiAnswer, type StreamEvent } from './ai.service';
import { BudgetService } from './budget.service';
import { CalibrationService } from './calibration.service';
import type { AiAsk, AiMode, Surface } from './core/types';
import { DraftsService } from './drafts.service';
import { InsightsService } from './insights.service';
import { StripService } from './strip.service';
import { AiToolBackend } from './tool-backend.service';

const RESEARCH: Role[] = [...ROBOT_BUILDER_ROLES, ...AUDIT_READ_ALL_ROLES];
const PRO: Role[] = [...PRO_ROLES];

const ContextSchema = z
  .strictObject({
    panel: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .optional(),
    symbol: z.string().regex(SYMBOL_RE).optional(),
    timeframe: z.enum(TIMEFRAMES).optional(),
    robotId: z.uuid().optional(),
    signalId: z.uuid().optional(),
    strategyId: z.uuid().optional(),
  })
  .default({});

const UntrustedSchema = z.strictObject({
  source: z.enum(['news', 'note', 'calendar', 'strategy', 'robot', 'other']),
  id: z.string().max(64).optional(),
  text: z.string().min(1).max(4000),
});

export const ChatSchema = z.strictObject({
  message: z.string().trim().min(1).max(2000),
  context: ContextSchema,
  mode: z.enum(['pro', 'novice']).optional(),
  surface: z.enum(['chat', 'robots']).default('chat'),
  untrusted: z.array(UntrustedSchema).max(5).optional(),
});

export const ExplainSchema = z.strictObject({
  topic: z.string().trim().min(1).max(60),
  screenText: z.string().max(2000).optional(),
  question: z.string().trim().max(500).optional(),
  context: ContextSchema,
});

const StripQuery = z.strictObject({
  symbol: z.string().regex(SYMBOL_RE),
  tf: z.enum(TIMEFRAMES).default('15m'),
});
const StripDraftSchema = z.strictObject({
  symbol: z.string().regex(SYMBOL_RE),
  timeframe: z.enum(TIMEFRAMES).default('15m'),
});
const DecisionSchema = z.strictObject({
  decision: z.enum(['accepted', 'rejected']),
  orderId: z.uuid().optional(),
  versionId: z.uuid().optional(),
});
const SuggestionDraftSchema = z.strictObject({
  param: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/),
  value: z.number().finite(),
  rationale: z.string().trim().min(1).max(300),
});
const CalibrationQuery = z.strictObject({
  modelKey: z.string().regex(/^(strategy|robot|bias|trend|news):[A-Za-z0-9:._-]{1,120}$/),
  rawScore: z.coerce.number().min(0).max(1).optional(),
});
const WhySchema = z.strictObject({ question: z.string().trim().max(500).optional() }).default({});

/** Novice-only accounts (and anyone asking in novice mode) get the plain-language mode. */
function modeFor(p: Principal, requested?: AiMode): AiMode {
  if (isNoviceOnly(p.roles)) return 'novice';
  return requested ?? 'pro';
}

function wantsStream(req: Request): boolean {
  return (req.headers.accept ?? '').includes('text/event-stream');
}

/**
 * AI copilot (goal 07). Explains, analyses and drafts; never executes. All answers end with "Not
 * investment advice."; unavailable, over-budget and rate-limited states are friendly 200 answers.
 */
@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly budget: BudgetService,
    private readonly strip: StripService,
    private readonly insights: InsightsService,
    private readonly drafts: DraftsService,
    private readonly calibration: CalibrationService,
    private readonly backend: AiToolBackend,
  ) {}

  private orgUser(p: Principal) {
    return { id: p.sub, roles: p.roles, orgId: this.ai.config().orgId };
  }

  /** JSON, or Server-Sent Events (`delta`, `tool`, `final`) when the client accepts text/event-stream. */
  private async respond(req: Request, res: Response, ask: AiAsk): Promise<void> {
    if (!wantsStream(req)) {
      res.status(200).json(await this.ai.ask(ask));
      return;
    }
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    let closed = false;
    req.on('close', () => (closed = true));
    // `delta` events carry only sentences that passed the output guards (IRTC R4-01, see
    // core/stream-guard.ts); novice answers are also checked as a whole (readability, no
    // suggestions) before anything is shown, so they are never streamed.
    const streamDeltas = ask.mode !== 'novice';
    const send = (e: StreamEvent) => {
      if (closed) return;
      if (e.type === 'delta' && !streamDeltas) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.type === 'final' ? e.answer : e)}\n\n`);
    };
    try {
      await this.ai.ask(ask, send);
    } catch {
      send({
        type: 'final',
        answer: {
          status: 'error',
          message: 'The copilot could not answer this time. Nothing was changed.',
        },
      });
    }
    res.end();
  }

  @Get('status')
  @ApiOperation({
    summary: 'Is the copilot available, and today’s token usage against the budgets.',
  })
  async status(@CurrentPrincipal() p: Principal) {
    const cfg = this.ai.config();
    return {
      ...this.ai.status(),
      usage: await this.budget.usage(p.sub, cfg).catch(() => null),
      mode: modeFor(p),
    };
  }

  @Post('chat')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Ask the copilot with the focused panel as context. Streams with Accept: text/event-stream. Draft-only; never executes.',
  })
  @ApiBody({ schema: openApiSchema(ChatSchema) })
  async chat(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(ChatSchema)) body: z.infer<typeof ChatSchema>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ask: AiAsk = {
      user: this.orgUser(p),
      surface: body.surface as Surface,
      mode: modeFor(p, body.mode),
      message: body.message,
      context: body.context,
      untrusted: body.untrusted,
    };
    await this.respond(req, res, ask);
  }

  @Post('explain')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Novice "Explain this to me": plain words (grade ≤ 8), no trade suggestions, no drafts. Any signed-in role.',
  })
  @ApiBody({ schema: openApiSchema(ExplainSchema) })
  async explain(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(ExplainSchema)) body: z.infer<typeof ExplainSchema>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ask: AiAsk = {
      user: this.orgUser(p),
      surface: 'explain',
      mode: 'novice',
      message: body.question || `Explain this to me: ${body.topic}`,
      context: body.context,
      grounding: { topic: body.topic },
      untrusted: body.screenText
        ? [{ source: 'other', id: 'screen', text: body.screenText }]
        : undefined,
    };
    await this.respond(req, res, ask);
  }

  @Get('strip')
  @Roles(...PRO)
  @ApiOperation({
    summary:
      'Terminal AI strip: bias, calibrated confidence or "No edge after costs", drivers, event risk. Data only.',
  })
  stripView(@Query(new ZodValidationPipe(StripQuery)) q: z.infer<typeof StripQuery>) {
    return this.strip.strip(q.symbol, q.tf, this.ai.config());
  }

  @Post('strip/draft')
  @HttpCode(200)
  @Roles('trader')
  @ApiOperation({
    summary:
      'Draft to ticket from the strip: an audited order DRAFT the user previews and confirms. Never submits.',
  })
  @ApiBody({ schema: openApiSchema(StripDraftSchema) })
  async stripDraft(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(StripDraftSchema)) body: z.infer<typeof StripDraftSchema>,
  ) {
    const cfg = this.ai.config();
    return this.strip.draft(
      {
        user: this.orgUser(p),
        mode: 'pro',
        surface: 'strip',
        modelId: 'rules:strip-bias',
        promptHash: 'none',
      },
      body.symbol,
      body.timeframe,
      cfg,
    );
  }

  @Post('signals/:id/why')
  @HttpCode(200)
  @Roles(...RESEARCH)
  @ApiOperation({
    summary:
      'Why did this trade happen: explanation grounded in the stored features (the chart comes from GET /signals/:id/features).',
  })
  async why(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(WhySchema)) body: z.infer<typeof WhySchema>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = this.orgUser(p);
    const ctx = {
      user,
      mode: 'pro' as const,
      surface: 'why' as const,
      modelId: 'grounding',
      promptHash: 'none',
    };
    let features: Awaited<ReturnType<AiToolBackend['get_signal_features']>>;
    try {
      features = await this.backend.get_signal_features(ctx, { signalId: id });
    } catch {
      res.status(404).json({ statusCode: 404, error: 'not_found', message: 'Signal not found.' });
      return;
    }
    const ask: AiAsk = {
      user,
      surface: 'why',
      mode: 'pro',
      message:
        body.question ||
        `Why did this trade happen (${features.action} ${features.symbol} at ${features.barTs.slice(11, 16)} UTC)?`,
      context: { signalId: id },
      grounding: { features },
    };
    await this.respond(req, res, ask);
  }

  @Get('robots/:id/insights')
  @Roles(...RESEARCH)
  @ApiOperation({
    summary:
      'Copilot drawer: calibrated confidence for the robot’s strategy and data-derived suggestions.',
  })
  robotInsights(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.insights.robot(p.sub, p.roles, id, this.ai.config().calibrationMinN);
  }

  @Post('robots/:id/suggestions/draft')
  @HttpCode(200)
  @Roles(...ROBOT_BUILDER_ROLES)
  @ApiOperation({
    summary:
      'Create an UNAPPROVED strategy draft from a suggestion. Validated, never saved as a version.',
  })
  @ApiBody({ schema: openApiSchema(SuggestionDraftSchema) })
  async suggestionDraft(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(SuggestionDraftSchema)) body: z.infer<typeof SuggestionDraftSchema>,
  ) {
    const detail = await this.insights.robot(p.sub, p.roles, id, this.ai.config().calibrationMinN);
    return this.drafts.createStrategyDraft(
      {
        user: this.orgUser(p),
        mode: 'pro',
        surface: 'robots',
        modelId: 'rules:robot-insights',
        promptHash: 'none',
        author: 'user',
      },
      {
        strategyId: detail.strategyId,
        changes: [{ param: body.param, value: body.value }],
        rationale: body.rationale,
      },
    );
  }

  @Get('scan/no-edge')
  @Roles(...RESEARCH)
  @ApiOperation({
    summary: 'Scan my robots for no edge after costs (calibration table, out-of-sample trades).',
  })
  scan(@CurrentPrincipal() p: Principal) {
    return this.insights.scanNoEdge(p.sub, p.roles, this.ai.config().calibrationMinN);
  }

  @Get('calibration')
  @ApiOperation({
    summary:
      'Calibration table of a model: reliability bins, edge after costs, confidence for a raw score.',
  })
  async calibrationView(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(CalibrationQuery)) q: z.infer<typeof CalibrationQuery>,
  ) {
    await this.calibration.assertAccess(p.sub, p.roles, q.modelKey);
    return this.calibration.view(q.modelKey, q.rawScore ?? null, this.ai.config().calibrationMinN);
  }

  @Post('calibration/strategies/:id/rebuild')
  @HttpCode(200)
  @Roles(...ROBOT_BUILDER_ROLES)
  @ApiOperation({
    summary: 'Rebuild a strategy’s calibration bins from the OOS trades of its latest backtest.',
  })
  async rebuild(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    const key = await this.calibration.ensureStrategy(p.sub, p.roles, id, true);
    return this.calibration.view(key, null, this.ai.config().calibrationMinN);
  }

  @Get('drafts/:id')
  @ApiOperation({ summary: 'One of my AI drafts (order or strategy).' })
  draft(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.drafts.get(p.sub, id);
  }

  @Post('drafts/:id/decision')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Record my decision on an AI draft: accepted (with the order I placed / version I saved) or rejected. Audited.',
  })
  @ApiBody({ schema: openApiSchema(DecisionSchema) })
  decide(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) body: z.infer<typeof DecisionSchema>,
  ) {
    return this.drafts.decide(p.sub, p.roles, id, body);
  }
}

export type { AiAnswer };
