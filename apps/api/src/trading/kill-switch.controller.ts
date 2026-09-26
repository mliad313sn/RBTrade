import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  KillSwitchRequestWithReasonSchema,
  KillSwitchResumeSchema,
  type KillSwitchRequestWithReason,
  type KillSwitchResume,
} from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { KillSwitchService } from './kill-switch.service';

const ResumeQuery = z.object({ accountId: z.uuid().optional() }).strict();

/**
 * Kill switch (goal 01 contract, goal 03 engine). REST works without the WebSocket, so it is also
 * the fallback path. Every scope halts robots; scope 2 cancels every open order; scope 3 also
 * flattens every position. Idempotent and audited, including each child action.
 */
@ApiTags('kill-switch')
@Controller('kill-switch')
export class KillSwitchController {
  constructor(private readonly ks: KillSwitchService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Trigger the kill switch: robots | robots_cancel | robots_cancel_flatten. Idempotent, audited, REST fallback.',
  })
  @ApiBody({ schema: openApiSchema(KillSwitchRequestWithReasonSchema) })
  trigger(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(KillSwitchRequestWithReasonSchema))
    body: KillSwitchRequestWithReason,
  ) {
    return this.ks.trigger(p.sub, body);
  }

  @Post('resume')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Resume trading after a halt (trader, quant, risk officer or admin; MFA). Risk officers/admins may pass accountId.',
  })
  @ApiBody({ schema: openApiSchema(KillSwitchResumeSchema) })
  @ApiQuery({ name: 'accountId', required: false })
  resume(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(KillSwitchResumeSchema)) body: KillSwitchResume,
    @Query(new ZodValidationPipe(ResumeQuery)) q: z.infer<typeof ResumeQuery>,
  ) {
    return this.ks.resume(p.sub, p.roles, body.reason, q.accountId);
  }

  @Get()
  @ApiOperation({ summary: 'Current halt state of your paper account.' })
  state(@CurrentPrincipal() p: Principal) {
    return this.ks.state(p.sub);
  }
}
