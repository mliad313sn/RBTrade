import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { KILL_SWITCH_SCOPES } from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { AlertsBridgeService } from './alerts-bridge.service';
import { RiskConsoleService } from './risk-console.service';

const AlertsQuery = z.strictObject({
  open: z.enum(['true', 'false']).optional(),
  kind: z
    .string()
    .regex(/^[a-z0-9_.]{1,64}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const AckSchema = z.strictObject({ note: z.string().trim().min(1).max(500).optional() });
const GlobalKillSchema = z.strictObject({
  scope: z.enum(KILL_SWITCH_SCOPES),
  reason: z.string().trim().min(3).max(500),
});

/**
 * Risk officer console (goal 09, 2nd line): firm exposure and loss vs limits, breaches, robots near
 * auto-pause, pending four-eyes approvals, kill-switch history, reconciliation breaks, AI draft
 * rates, novice guardrail events (B-810), alerts (live on WS `risk:alerts`), global kill switch.
 */
@ApiTags('risk-console')
@Controller('risk-console')
@Roles('risk_officer', 'admin')
export class RiskConsoleController {
  constructor(
    private readonly console: RiskConsoleService,
    private readonly bridge: AlertsBridgeService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Everything the console shows, in one call (real goal 03/06 data).' })
  overview() {
    return this.console.overview();
  }

  @Get('exposure')
  @ApiOperation({ summary: 'Firm exposure and loss vs limits per account.' })
  exposure() {
    return this.console.exposure();
  }

  @Get('robots')
  @ApiOperation({ summary: 'Running robots and their usage of each auto-pause limit.' })
  robots() {
    return this.console.robotsNearPause();
  }

  @Get('approvals')
  @ApiOperation({ summary: 'Pending four-eyes requests and robots waiting for a risk sign-off.' })
  approvals() {
    return this.console.pendingApprovals();
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Alerts (REST fallback for the live channel).' })
  @ApiQuery({ name: 'open', required: false })
  @ApiQuery({ name: 'kind', required: false, description: 'prefix, e.g. risk. or kill_switch.' })
  async alerts(@Query(new ZodValidationPipe(AlertsQuery)) q: z.infer<typeof AlertsQuery>) {
    return { alerts: await this.console.alerts({ open: q.open === 'true', kind: q.kind, limit: q.limit }), relay: this.bridge.stats };
  }

  @Post('alerts/:id/ack')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acknowledge an alert (audited).' })
  @ApiBody({ schema: openApiSchema(AckSchema) })
  ack(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AckSchema)) body: z.infer<typeof AckSchema>,
  ) {
    return this.console.acknowledge(p.sub, id, body.note ?? null);
  }

  @Post('kill-switch')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'B-314: firm-wide kill switch on every active account (risk officer/admin, MFA). Each account then needs four eyes to resume.',
  })
  @ApiBody({ schema: openApiSchema(GlobalKillSchema) })
  killAll(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(GlobalKillSchema)) body: z.infer<typeof GlobalKillSchema>) {
    return this.console.globalKillSwitch(p.sub, body.scope, body.reason);
  }
}
