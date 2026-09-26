import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  FOUR_EYES_KINDS,
  FOUR_EYES_STATUSES,
  FourEyesCreateSchema,
  FourEyesDecisionSchema,
  hasAnyRole,
  APPROVER_ROLES,
  type FourEyesCreate,
} from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { FourEyesService } from './four-eyes.service';

const ListQuery = z.strictObject({
  status: z.enum(FOUR_EYES_STATUSES).optional(),
  kind: z.enum(FOUR_EYES_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Four-eyes approvals (goal 09). Anyone may see their own requests; risk officers and admins see and
 * decide everyone's. The approver is never the requester (API and database trigger).
 */
@ApiTags('governance')
@Controller('governance/approvals')
export class ApprovalsController {
  constructor(private readonly fourEyes: FourEyesService) {}

  @Get()
  @ApiOperation({ summary: 'Four-eyes requests (risk officers/admins: all; others: their own).' })
  @ApiQuery({ name: 'status', required: false, enum: FOUR_EYES_STATUSES })
  @ApiQuery({ name: 'kind', required: false, enum: FOUR_EYES_KINDS })
  async list(@CurrentPrincipal() p: Principal, @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    const all = await this.fourEyes.list(q);
    return { requests: hasAnyRole(p.roles, APPROVER_ROLES) ? all : all.filter((r) => r.requestedBy === p.sub) };
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Open a four-eyes request: limit_override (loosen above the platform limit), mfa_reset (admin), disclosure_publish (document version or Compliance value).',
  })
  @ApiBody({ schema: openApiSchema(FourEyesCreateSchema) })
  create(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(FourEyesCreateSchema)) body: FourEyesCreate) {
    return this.fourEyes.create(p.sub, p.roles, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One request.' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.fourEyes.get(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve and execute (risk officer/admin, not the requester, not the person it is about).' })
  @ApiBody({ schema: openApiSchema(FourEyesDecisionSchema) })
  approve(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(FourEyesDecisionSchema)) body: z.infer<typeof FourEyesDecisionSchema>,
  ) {
    return this.fourEyes.approve(p.sub, p.roles, id, body.note);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject (risk officer/admin, not the requester).' })
  @ApiBody({ schema: openApiSchema(FourEyesDecisionSchema) })
  reject(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(FourEyesDecisionSchema)) body: z.infer<typeof FourEyesDecisionSchema>,
  ) {
    return this.fourEyes.reject(p.sub, p.roles, id, body.note);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw your own pending request.' })
  @ApiBody({ schema: openApiSchema(FourEyesDecisionSchema) })
  cancel(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(FourEyesDecisionSchema)) body: z.infer<typeof FourEyesDecisionSchema>,
  ) {
    return this.fourEyes.cancel(p.sub, id, body.note);
  }
}
