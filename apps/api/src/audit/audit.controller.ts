import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ACTOR_TYPES, AUDIT_READ_ROLES, hasAnyRole } from '@kora/domain';
import { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';
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
    beforeId: z
      .string()
      .regex(/^\d{1,19}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

/** IRTC R1-08: chain verification is O(N); its own low limit per client (read per request). */
const verifyThrottle = () => ({
  default: {
    limit: () => Number(process.env.KORA_AUDIT_VERIFY_RATE_LIMIT ?? 10) || 10,
    ttl: 60_000,
  },
});

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly db: DbService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List audit events (newest first). Non-privileged users see their own events and system/robot events about their own account (B-303); risk officers, admins and auditors see all.',
  })
  @ApiQuery({ name: 'actorId', required: false })
  @ApiQuery({ name: 'actorType', required: false, enum: ACTOR_TYPES })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({
    name: 'action',
    required: false,
    description: 'exact, or prefix with .* (e.g. kill_switch.*)',
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO-8601, inclusive' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO-8601, exclusive' })
  @ApiQuery({ name: 'beforeId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(AuditQuerySchema)) q: z.infer<typeof AuditQuerySchema>,
  ) {
    if (!hasAnyRole(principal.roles, AUDIT_READ_ROLES)) {
      if (q.actorId && q.actorId !== principal.sub) {
        throw new ForbiddenException({
          error: 'forbidden',
          message: 'You can only read your own audit events',
        });
      }
      // B-303: your own events, plus engine/robot/system events about your own paper account.
      const accounts = await this.db.query<{ id: string }>(
        'SELECT id FROM accounts WHERE user_id = $1',
        [principal.sub],
      );
      return this.audit.list({
        ...q,
        actorId: undefined,
        visibleTo: { userId: principal.sub, accountIds: accounts.map((a) => a.id) },
      });
    }
    return this.audit.list(q);
  }

  @Get('verify')
  @Throttle(verifyThrottle())
  @ApiOperation({
    summary:
      'Recompute the hash chain. Auditors, risk officers and admins verify the whole chain (scope "chain"); everyone else verifies their own events and their links (scope "own", no platform totals). Returns valid:false with the first broken id on tamper. IRTC R1-08: 10 per minute per client.',
  })
  async verify(@CurrentPrincipal() principal: Principal) {
    if (hasAnyRole(principal.roles, AUDIT_READ_ROLES))
      return { ...(await this.audit.verifyShared()), scope: 'chain' as const };
    const accounts = await this.db.query<{ id: string }>(
      'SELECT id FROM accounts WHERE user_id = $1',
      [principal.sub],
    );
    return this.audit.verifyOwn({ userId: principal.sub, accountIds: accounts.map((a) => a.id) });
  }
}
