import { Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ACTOR_TYPES, AUDIT_READ_ROLES } from '@kora/domain';
import type { Response } from 'express';
import { z } from 'zod';

import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod';
import { AnchorsService } from './anchors.service';
import { parseRange } from './controls/evidence.service';
import { toCsv } from './export/csv';
import { InternalAuditService } from './internal-audit.service';

const EventsQuery = z.strictObject({
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
});

const SampleQuery = z.strictObject({
  controlId: z.string().regex(/^KC-\d{2}$/),
  n: z.coerce.number().int().min(1).max(500).default(25),
  seed: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

/**
 * Internal audit (goal 09, 3rd line): read-only audit log with hash-chain and anchor verification,
 * reproducible sampling per control, CSV export. Auditors cannot change anything else.
 */
@ApiTags('internal-audit')
@Controller('internal-audit')
@Roles(...AUDIT_READ_ROLES)
export class InternalAuditController {
  constructor(
    private readonly ia: InternalAuditService,
    private readonly anchors: AnchorsService,
  ) {}

  @Get('events')
  @ApiOperation({ summary: 'Every audit event (newest first), filterable; read-only.' })
  events(@Query(new ZodValidationPipe(EventsQuery)) q: z.infer<typeof EventsQuery>) {
    return this.ia.events(q);
  }

  @Get('events/export')
  @ApiOperation({ summary: 'CSV export of up to 500 filtered events (audited).' })
  async exportEvents(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(EventsQuery)) q: z.infer<typeof EventsQuery>,
    @Res() res: Response,
  ) {
    const out = await this.ia.exportEvents(q, p.sub);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kora-audit-events.csv"`);
    if (out.nextBeforeId) res.setHeader('X-Kora-Next-Before-Id', out.nextBeforeId);
    res.status(200).send(out.csv);
  }

  @Get('verify')
  @ApiOperation({ summary: 'Recompute the hash chain and check every signed anchor (the run is recorded).' })
  verify(@CurrentPrincipal() p: Principal) {
    return this.ia.verify(p.sub);
  }

  @Get('anchors')
  @ApiOperation({ summary: 'Signed anchors of the audit head (B-007) with signature and chain checks.' })
  async listAnchors() {
    return { keyId: this.anchors.keyId, anchors: await this.anchors.list() };
  }

  @Post('anchors')
  @HttpCode(201)
  @Roles('admin', 'risk_officer')
  @ApiOperation({ summary: 'Anchor the current audit head now (also runs daily in production).' })
  anchor(@CurrentPrincipal() p: Principal) {
    return this.anchors.anchor(p.sub);
  }

  @Get('sample')
  @ApiOperation({
    summary:
      'Random sample of N items for a control (its audit events in the period, or its evidence rows). Reproducible with the returned seed; recorded as internal_audit.sample_drawn.',
  })
  @ApiQuery({ name: 'controlId', required: true })
  @ApiQuery({ name: 'n', required: false })
  @ApiQuery({ name: 'seed', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async sample(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(SampleQuery)) q: z.infer<typeof SampleQuery>,
    @Res() res: Response,
  ) {
    const s = await this.ia.sample(q.controlId, q.n, parseRange(q.from, q.to), q.seed, p.sub);
    if (q.format === 'csv') {
      const csv = s.events
        ? toCsv(
            ['id', 'ts', 'actor_id', 'actor_type', 'action', 'entity', 'entity_id', 'payload', 'hash'],
            s.events.map((e) => [e.id, e.ts, e.actorId, e.actorType, e.action, e.entity, e.entityId, JSON.stringify(e.payload), e.hash]),
          )
        : toCsv(s.columns ?? [], s.rows ?? []);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="kora-sample_${q.controlId}_seed-${s.seed}.csv"`);
      res.setHeader('X-Kora-Sample-Seed', s.seed);
      res.status(200).send(csv);
      return;
    }
    res.status(200).json(s);
  }
}
