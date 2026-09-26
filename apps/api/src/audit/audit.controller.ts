import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ACTOR_TYPES, AUDIT_READ_ALL_ROLES, hasAnyRole } from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod';
import { AuditService } from './audit.service';

const AuditQuerySchema = z
  .object({
    actorId: z.string().max(128).optional(),
    actorType: z.enum(ACTOR_TYPES).optional(),
    entity: z.string().max(64).optional(),
    entityId: z.string().max(128).optional(),
    action: z
      .string()
      .max(128)
      .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/)
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    beforeId: z.string().regex(/^\d{1,19}$/).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'List audit events (newest first). Non-privileged users see their own events.' })
  @ApiQuery({ name: 'actorId', required: false })
  @ApiQuery({ name: 'actorType', required: false, enum: ACTOR_TYPES })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'action', required: false, description: 'exact, or prefix with .* (e.g. kill_switch.*)' })
  @ApiQuery({ name: 'from', required: false, description: 'ISO-8601, inclusive' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO-8601, exclusive' })
  @ApiQuery({ name: 'beforeId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(AuditQuerySchema)) q: z.infer<typeof AuditQuerySchema>,
  ) {
    if (!hasAnyRole(principal.roles, AUDIT_READ_ALL_ROLES)) {
      if (q.actorId && q.actorId !== principal.sub) {
        throw new ForbiddenException({ error: 'forbidden', message: 'You can only read your own audit events' });
      }
      q.actorId = principal.sub;
    }
    return this.audit.list(q);
  }

  @Get('verify')
  @ApiOperation({ summary: 'Recompute the hash chain. Returns valid:false with the first broken id on tamper.' })
  verify() {
    return this.audit.verify();
  }
}
