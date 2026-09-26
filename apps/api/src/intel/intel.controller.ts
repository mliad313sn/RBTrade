import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { ASSET_CLASSES, hasAnyRole, SYMBOL_RE, type Role } from '@kora/domain';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { AiService, type StreamEvent } from '../ai/ai.service';
import type { AiAsk, AiMode } from '../ai/core/types';
import { DraftsService } from '../ai/drafts.service';
import { CurrentPrincipal, Public, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { AlertsService, CreateAlertSchema } from './alerts.service';
import { RADAR_REGIONS } from './core/taxonomy';
import { IntelReadService } from './intel-read.service';
import { NewsService } from './news.service';
import { ScanService } from './scan.service';

const PRO: Role[] = ['trader', 'quant', 'risk_officer', 'admin'];
const horizon = z
  .string()
  .regex(/^[0-9a-z]{1,8}$/)
  .default('1d');

const RadarQuery = z.strictObject({
  region: z.enum(RADAR_REGIONS).optional(),
  assetClass: z.enum(ASSET_CLASSES).optional(),
  sector: z
    .string()
    .regex(/^[a-z_]{2,32}$/)
    .optional(),
  window: z.enum(['day', 'week']).default('week'),
  groupBy: z.enum(['region', 'assetClass', 'sector']).default('region'),
});
const CardQuery = z.strictObject({ horizon });
const ExplainSchema = z
  .strictObject({ horizon, mode: z.enum(['pro', 'novice']).optional() })
  .default({ horizon: '1d' });
const DraftSchema = z.strictObject({ horizon }).default({ horizon: '1d' });
const NewsQuery = z.strictObject({
  symbol: z.string().regex(SYMBOL_RE).optional(),
  region: z.enum(RADAR_REGIONS).optional(),
  hours: z.coerce.number().int().min(1).max(336).default(168),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const IngestSchema = z
  .strictObject({
    adapter: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .default('simulated'),
  })
  .default({ adapter: 'simulated' });
const Symbol = z.string().regex(SYMBOL_RE);

function modeFor(p: Principal, requested?: AiMode): AiMode {
  if (!hasAnyRole(p.roles, PRO)) return 'novice';
  return requested ?? 'pro';
}

/**
 * Market intelligence (goal 07B): Market Radar, trend cards (with a grounded plain-language summary),
 * news, server-evaluated alerts, the novice "What's moving" card, the provider matrix and the public
 * reliability page. Detected trends and forecasts are SIMULATED and never advice; drafts are drafts.
 */
@ApiTags('intel')
@Controller('intel')
export class IntelController {
  constructor(
    private readonly read: IntelReadService,
    private readonly scans: ScanService,
    private readonly news: NewsService,
    private readonly alerts: AlertsService,
    private readonly ai: AiService,
    private readonly drafts: DraftsService,
  ) {}

  private symbol(raw: string): string {
    const s = Symbol.safeParse(raw.toUpperCase());
    if (!s.success)
      throw new BadRequestException({ error: 'invalid_symbol', message: 'Unknown symbol format.' });
    return s.data;
  }

  @Get('radar')
  @ApiOperation({
    summary:
      'Market Radar: heat map, ranked emerging trends and movers from the latest scan (SIMULATED).',
  })
  radar(@Query(new ZodValidationPipe(RadarQuery)) q: z.infer<typeof RadarQuery>) {
    return this.read.radar(
      { region: q.region, assetClass: q.assetClass, sector: q.sector },
      q.window,
      q.groupBy,
    );
  }

  @Get('trends/:symbol')
  @ApiOperation({
    summary:
      'Trend card: direction, calibrated probability or "No reliable signal", drivers, regime, risk, invalidation, cited news.',
  })
  card(
    @Param('symbol') symbol: string,
    @Query(new ZodValidationPipe(CardQuery)) q: z.infer<typeof CardQuery>,
  ) {
    return this.read.trendCard(this.symbol(symbol), q.horizon);
  }

  @Post('trends/:symbol/explain')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Plain-language summary of a trend card written by the copilot from the card only (numbers checked). SSE with Accept: text/event-stream.',
  })
  @ApiBody({ schema: openApiSchema(ExplainSchema) })
  async explain(
    @CurrentPrincipal() p: Principal,
    @Param('symbol') raw: string,
    @Body(new ZodValidationPipe(ExplainSchema)) body: z.infer<typeof ExplainSchema>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const symbol = this.symbol(raw);
    const card = await this.read.trendCard(symbol, body.horizon);
    const mode = modeFor(p, body.mode);
    const ask: AiAsk = {
      user: { id: p.sub, roles: p.roles, orgId: this.ai.config().orgId },
      surface: 'radar',
      mode,
      message:
        mode === 'novice'
          ? `What is moving with ${card.name} and why? Explain it simply.`
          : `Summarise the ${body.horizon} trend card for ${symbol}: the view, its evidence, the probability status, what would invalidate it and the cited news.`,
      context: { symbol, panel: 'radar' },
      grounding: { card },
    };
    if (!(req.headers.accept ?? '').includes('text/event-stream')) {
      res.status(200).json({ ...(await this.ai.ask(ask)), card });
      return;
    }
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    let closed = false;
    req.on('close', () => (closed = true));
    const send = (e: StreamEvent) => {
      if (closed || (e.type === 'delta' && mode === 'novice')) return;
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

  @Post('trends/:symbol/draft')
  @HttpCode(200)
  @Roles('trader')
  @ApiOperation({
    summary:
      'Draft to ticket from a trend card: an audited order DRAFT the user previews and confirms in the ticket. Never submits.',
  })
  @ApiBody({ schema: openApiSchema(DraftSchema) })
  async draft(
    @CurrentPrincipal() p: Principal,
    @Param('symbol') raw: string,
    @Body(new ZodValidationPipe(DraftSchema)) body: z.infer<typeof DraftSchema>,
  ) {
    const symbol = this.symbol(raw);
    const card = await this.read.trendCard(symbol, body.horizon);
    if (!card.direction)
      throw new BadRequestException({
        error: 'no_direction',
        message: 'This trend has no up or down direction, so there is nothing to draft.',
      });
    const rationale =
      `Market Radar ${card.trend?.label ?? 'trend'} on ${symbol} (${body.horizon}, SIMULATED). ${
        card.probability.status === 'calibrated'
          ? `Calibrated ${card.probability.value}.`
          : 'No reliable signal.'
      } Review before placing.`.slice(0, 300);
    return this.drafts.createOrderDraft(
      {
        user: { id: p.sub, roles: p.roles, orgId: this.ai.config().orgId },
        mode: 'pro',
        surface: 'radar',
        modelId: 'rules:market-radar',
        promptHash: 'none',
      },
      { symbol, side: card.direction === 'up' ? 'buy' : 'sell', type: 'market', rationale },
    );
  }

  @Get('news')
  @ApiOperation({
    summary:
      'Recent SIMULATED news with source, time, link, translation and schema-validated scores.',
  })
  newsList(@Query(new ZodValidationPipe(NewsQuery)) q: z.infer<typeof NewsQuery>) {
    return this.read.news(q);
  }

  @Post('news/ingest')
  @HttpCode(200)
  @Roles('admin', 'quant')
  @ApiOperation({
    summary:
      'Run the news pipeline for one adapter (SIMULATED fixtures; licensed providers are flagged stubs).',
  })
  @ApiBody({ schema: openApiSchema(IngestSchema) })
  ingest(@Body(new ZodValidationPipe(IngestSchema)) body: z.infer<typeof IngestSchema>) {
    return this.news.ingest(body.adapter);
  }

  @Post('scan')
  @HttpCode(200)
  @Roles('admin', 'quant')
  @ApiOperation({ summary: 'Run a scan of the SIMULATED universe now (normally on bar close).' })
  scan(@CurrentPrincipal() p: Principal) {
    return this.scans.run('manual', p.sub);
  }

  @Get('alerts')
  @Roles(...PRO)
  @ApiOperation({ summary: 'My Market Radar alerts and their server-evaluated matches.' })
  alertList(@CurrentPrincipal() p: Principal) {
    return this.alerts.list(p.sub);
  }

  @Post('alerts')
  @Roles(...PRO)
  @ApiOperation({
    summary:
      'Create a Market Radar alert (evaluated by the server after every scan; notifies only).',
  })
  @ApiBody({ schema: openApiSchema(CreateAlertSchema) })
  alertCreate(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(CreateAlertSchema)) body: z.infer<typeof CreateAlertSchema>,
  ) {
    return this.alerts.create(p.sub, body);
  }

  @Delete('alerts/:id')
  @Roles(...PRO)
  @ApiOperation({ summary: 'Delete one of my Market Radar alerts.' })
  alertDelete(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.alerts.remove(p.sub, id);
  }

  @Get('whats-moving')
  @ApiOperation({
    summary:
      'Novice "What\'s moving and why": plain words, no advice, a probability only if calibrated.',
  })
  whatsMoving() {
    return this.read.whatsMoving();
  }

  @Get('providers')
  @ApiOperation({
    summary:
      'Provider adapter matrix per continent (every source is a flagged stub until licensed).',
  })
  providers() {
    return this.read.providers();
  }

  @Get('reliability')
  @Public()
  @ApiOperation({
    summary: 'Public track record per model and region, from stored predictions and outcomes.',
  })
  reliability() {
    return this.read.reliability();
  }
}
