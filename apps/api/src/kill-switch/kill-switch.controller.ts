import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { KILL_SWITCH_SCOPE_LABELS, KillSwitchRequestSchema, type KillSwitchRequest } from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';

/**
 * Kill-switch entry point (goal 01: records intent only). Goal 03 wires the engine: halt robots,
 * cancel working orders, flatten positions, each child action audited. This REST route is also the
 * fallback when the websocket is down.
 */
@ApiTags('kill-switch')
@Controller('kill-switch')
export class KillSwitchController {
  constructor(private readonly audit: AuditService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Request a kill switch with one of three scopes. Always audited.' })
  @ApiBody({ schema: openApiSchema(KillSwitchRequestSchema) })
  async trigger(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(KillSwitchRequestSchema)) body: KillSwitchRequest,
  ) {
    const event = await this.audit.record({
      actorId: p.sub,
      actorType: 'user',
      action: 'kill_switch.requested',
      entity: 'kill_switch',
      entityId: body.scope,
      payload: { scope: body.scope, source: body.source, environment: 'PAPER', engine: 'not_wired_goal_03' },
    });
    return {
      accepted: true,
      scope: body.scope,
      label: KILL_SWITCH_SCOPE_LABELS[body.scope].title,
      auditEventId: event.id,
      engine: 'not_wired_goal_03' as const,
    };
  }
}
