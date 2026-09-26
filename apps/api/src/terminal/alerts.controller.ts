import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CreateAlertSchema, type CreateAlert } from '@kora/domain';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';
import { InstrumentsRepository } from '../market-data/instruments.repository';
import { toAlertDto, type AlertRow } from './alerts.service';

const MAX_ACTIVE_ALERTS = 200;
const COLUMNS = `id, user_id, symbol, condition, threshold::text AS threshold, timeframe, note, status, created_at, triggered_at, triggered_value::text AS triggered_value`;
const ListQuery = z
  .object({
    status: z.enum(['active', 'all']).default('all'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

/**
 * Price and indicator alerts (goal 04 blotter "Alerts" tab). Evaluated by the server
 * (`AlertsService`); create and cancel are audited.
 */
@ApiTags('terminal')
@Controller('price-alerts')
export class AlertsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly registry: InstrumentsRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The user’s price and indicator alerts, newest first.' })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'all'] })
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    const rows = await this.db.query<AlertRow>(
      `SELECT ${COLUMNS} FROM price_alerts WHERE user_id = $1 ${q.status === 'active' ? "AND status = 'active'" : ''} ORDER BY created_at DESC LIMIT $2`,
      [p.sub, q.limit],
    );
    return { alerts: rows.map(toAlertDto) };
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a price (above/below) or RSI(14) alert on a timeframe. Audited as alert.created.',
  })
  @ApiBody({ schema: openApiSchema(CreateAlertSchema) })
  async create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(CreateAlertSchema)) body: CreateAlert,
  ) {
    const reg = await this.registry.load();
    if (!reg.instruments.has(body.symbol))
      throw new BadRequestException({
        error: 'unknown_symbol',
        message: `Unknown symbol ${body.symbol}`,
      });
    const timeframe = body.condition.startsWith('rsi_') ? (body.timeframe ?? '15m') : null;
    return this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alerts:${p.sub}`]);
      const n = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM price_alerts WHERE user_id = $1 AND status = 'active'",
        [p.sub],
      );
      if (n.rows[0]!.n >= MAX_ACTIVE_ALERTS)
        throw new BadRequestException({
          error: 'too_many_alerts',
          message: `You can have up to ${MAX_ACTIVE_ALERTS} active alerts.`,
        });
      const r = await c.query<AlertRow>(
        `INSERT INTO price_alerts (user_id, symbol, condition, threshold, timeframe, note) VALUES ($1, $2, $3, $4::numeric, $5, $6) RETURNING ${COLUMNS}`,
        [p.sub, body.symbol, body.condition, body.threshold, timeframe, body.note ?? null],
      );
      const row = r.rows[0]!;
      await this.audit.record(
        {
          actorId: p.sub,
          actorType: 'user',
          action: 'alert.created',
          entity: 'price_alert',
          entityId: row.id,
          payload: {
            symbol: row.symbol,
            condition: row.condition,
            threshold: body.threshold,
            timeframe,
          },
        },
        c,
      );
      return toAlertDto(row);
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel an active alert. Audited as alert.cancelled.' })
  async cancel(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.tx(async (c) => {
      const r = await c.query<AlertRow>(
        `UPDATE price_alerts SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING ${COLUMNS}`,
        [id, p.sub],
      );
      const row = r.rows[0];
      if (!row) {
        const exists = await c.query(
          'SELECT status FROM price_alerts WHERE id = $1 AND user_id = $2',
          [id, p.sub],
        );
        if (!exists.rowCount)
          throw new NotFoundException({ error: 'not_found', message: 'Alert not found.' });
        throw new ConflictException({
          error: 'not_active',
          message: 'The alert is no longer active.',
        });
      }
      await this.audit.record(
        {
          actorId: p.sub,
          actorType: 'user',
          action: 'alert.cancelled',
          entity: 'price_alert',
          entityId: id,
          payload: { symbol: row.symbol },
        },
        c,
      );
      return toAlertDto(row);
    });
  }
}
