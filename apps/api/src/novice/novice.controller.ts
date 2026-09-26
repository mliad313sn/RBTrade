import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AttemptSchema, NOVICE_DIRECTIONS, SYMBOL_RE, type AttemptRequest } from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { orderThrottle } from '../trading/orders.controller';
import { AutoInvestService } from './auto-invest.service';
import { NoviceService } from './novice.service';

const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,8})?$/, 'Use an amount such as 500 or 500.00')
  .refine((v) => Number(v) > 0, 'Use an amount above zero');

export const NoviceLimitsSchema = z
  .strictObject({ dailyLossLimit: money.optional(), monthlyLossLimit: money.optional() })
  .refine((b) => b.dailyLossLimit || b.monthlyLossLimit, 'Set at least one limit');
export const NoviceLeverageSchema = z.strictObject({ enabled: z.boolean() });
export const NoviceTicketSchema = z.strictObject({
  symbol: z.string().regex(SYMBOL_RE),
  direction: z.enum(NOVICE_DIRECTIONS),
  amount: money,
  safetyNetPct: z
    .string()
    .trim()
    .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Use a percentage such as 3'),
});
export const AutoInvestSchema = z.strictObject({
  templateId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  amount: money,
});

/**
 * Novice view (goal 08). Any signed-in user may call these; guardrails apply to guarded users
 * (novice-only or in the Novice view) and are enforced by the OMS, not by this controller.
 */
@ApiTags('novice')
@Controller('novice')
export class NoviceController {
  constructor(
    private readonly novice: NoviceService,
    private readonly autoInvest: AutoInvestService,
  ) {}

  @Get('profile')
  @ApiOperation({
    summary:
      'Onboarding state, loss limits (used / limit / pending loosenings), cooling-off, borrowing state and the knowledge check. PAPER.',
  })
  profile(@CurrentPrincipal() p: Principal) {
    return this.novice.profile(p);
  }

  @Post('onboarding/complete')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Finish onboarding. Requires the current risk warning acknowledged and both loss limits set (409 otherwise). Audited.',
  })
  complete(@CurrentPrincipal() p: Principal) {
    return this.novice.completeOnboarding(p);
  }

  @Put('limits')
  @ApiOperation({
    summary:
      'Daily and monthly loss limits. In the Novice view tightening applies now and loosening waits 24 h. Audited.',
  })
  @ApiBody({ schema: openApiSchema(NoviceLimitsSchema) })
  limits(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(NoviceLimitsSchema)) body: z.infer<typeof NoviceLimitsSchema>,
  ) {
    return this.novice.setLimits(p, body);
  }

  @Put('leverage')
  @ApiOperation({
    summary:
      'Ask to turn borrowing on (needs a passed knowledge check; waits 24 h; capped by KORA_NOVICE_MAX_LEVERAGE) or turn it off (immediate).',
  })
  @ApiBody({ schema: openApiSchema(NoviceLeverageSchema) })
  leverage(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(NoviceLeverageSchema)) body: z.infer<typeof NoviceLeverageSchema>,
  ) {
    return this.novice.setLeverage(p, body.enabled);
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Home numbers: balance, change since start, balance series, worst dip so far, holdings in words. SIMULATED.',
  })
  summary(@CurrentPrincipal() p: Principal) {
    return this.novice.summary(p);
  }

  @Get('assets')
  @ApiOperation({
    summary:
      'Curated novice instruments from the registry (novice_rank), with session state and the minimum amount in the account currency.',
  })
  assets(@CurrentPrincipal() p: Principal) {
    return this.novice.assets(p);
  }

  @Post('ticket')
  @HttpCode(200)
  @Throttle(orderThrottle())
  @ApiOperation({
    summary:
      'Build the novice market order from an amount (account currency) and a safety net (%), and return the unchanged /orders/preview answer for it. Place exactly `order` with POST /orders.',
  })
  @ApiBody({ schema: openApiSchema(NoviceTicketSchema) })
  ticket(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(NoviceTicketSchema)) body: z.infer<typeof NoviceTicketSchema>,
  ) {
    return this.novice.ticket(p, body);
  }

  @Get('knowledge-check')
  @ApiOperation({
    summary: 'The 5-question knowledge check (no answer key) and your status.',
  })
  knowledge(@CurrentPrincipal() p: Principal) {
    return this.novice.knowledgeCheck(p.sub);
  }

  @Post('knowledge-check/attempts')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Submit answers (graded server-side; pass mark 4/5; cool-down after a fail). Answers are never stored. Audited.',
  })
  @ApiBody({ schema: openApiSchema(AttemptSchema) })
  knowledgeAttempt(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(AttemptSchema)) body: AttemptRequest,
  ) {
    return this.novice.knowledgeAttempt(p.sub, body);
  }

  @Get('auto-invest')
  @ApiOperation({
    summary:
      'Ready-made robots (templates only) with a 1–5 risk level, out-of-sample test results and your own paper results. Never in-sample numbers.',
  })
  autoInvestList(@CurrentPrincipal() p: Principal) {
    return this.autoInvest.list(p);
  }

  @Post('auto-invest')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Start a ready-made robot with practice money (PAPER): unchanged template, capped amount, limits from your loss limits. Audited.',
  })
  @ApiBody({ schema: openApiSchema(AutoInvestSchema) })
  autoInvestCreate(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(AutoInvestSchema)) body: z.infer<typeof AutoInvestSchema>,
  ) {
    return this.autoInvest.create(p, body);
  }

  @Post('auto-invest/:id/pause')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pause one of your ready-made robots (audited).' })
  autoInvestPause(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.autoInvest.pause(p, id);
  }

  @Post('auto-invest/:id/resume')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Restart one of your ready-made robots (not while cooling off or halted).',
  })
  autoInvestResume(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.autoInvest.resume(p, id);
  }

  @Post('auto-invest/:id/go-live')
  @HttpCode(403)
  @ApiOperation({
    summary:
      'Always refused from the Novice view today (403 with the checklist: knowledge check, promotion rules, LIVE flag). Audited.',
  })
  autoInvestLive(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.autoInvest.goLive(p, id);
  }
}
