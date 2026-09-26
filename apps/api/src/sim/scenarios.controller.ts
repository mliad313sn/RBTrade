import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';

/** Most scenarios a user may keep per kind. */
export const MAX_SCENARIOS = 50;

const Kind = z.enum(['practice', 'pro']);
export const SaveScenarioSchema = z.strictObject({
  kind: Kind,
  name: z.string().trim().min(1).max(60),
  /** The simulator inputs only (results are recomputed, seeded and deterministic). */
  input: z
    .record(z.string().max(64), z.unknown())
    .refine((o) => JSON.stringify(o).length <= 16_384, 'Scenario inputs are too large'),
  /** Replace an existing scenario with the same name. */
  overwrite: z.boolean().default(false),
});
const ListQuery = z.strictObject({ kind: Kind.optional() });

interface Row {
  id: string;
  kind: 'practice' | 'pro';
  name: string;
  input: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const dto = (r: Row) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  input: r.input,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** B-505: save and name simulator scenarios per user (Novice Practice and the Pro simulator). */
@ApiTags('sim')
@Controller('sim/scenarios')
export class SimScenariosController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Your saved scenarios (newest first).' })
  @ApiQuery({ name: 'kind', required: false, enum: ['practice', 'pro'] })
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    const rows = await this.db.query<Row>(
      `SELECT * FROM sim_scenarios WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)
       ORDER BY updated_at DESC LIMIT ${MAX_SCENARIOS * 2}`,
      [p.sub, q.kind ?? null],
    );
    return { scenarios: rows.map(dto), max: MAX_SCENARIOS };
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Save (or overwrite) a named scenario. 409 when the name exists or the limit is reached. Audited.',
  })
  @ApiBody({ schema: openApiSchema(SaveScenarioSchema) })
  async save(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(SaveScenarioSchema)) body: z.infer<typeof SaveScenarioSchema>,
  ) {
    return this.db.tx(async (c) => {
      await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [p.sub]);
      const existing = await c.query<Row>(
        'SELECT * FROM sim_scenarios WHERE user_id = $1 AND kind = $2 AND name = $3',
        [p.sub, body.kind, body.name],
      );
      let row: Row;
      if (existing.rows[0]) {
        if (!body.overwrite)
          throw new ConflictException({
            error: 'name_taken',
            message: 'You already have a scenario with this name.',
          });
        row = (
          await c.query<Row>(
            'UPDATE sim_scenarios SET input = $2, updated_at = now() WHERE id = $1 RETURNING *',
            [existing.rows[0].id, JSON.stringify(body.input)],
          )
        ).rows[0]!;
      } else {
        const n = Number(
          (
            await c.query<{ n: string }>(
              'SELECT count(*)::text AS n FROM sim_scenarios WHERE user_id = $1 AND kind = $2',
              [p.sub, body.kind],
            )
          ).rows[0]!.n,
        );
        if (n >= MAX_SCENARIOS)
          throw new ConflictException({
            error: 'too_many_scenarios',
            message: `You can keep up to ${MAX_SCENARIOS} scenarios. Delete one first.`,
          });
        row = (
          await c.query<Row>(
            'INSERT INTO sim_scenarios (user_id, kind, name, input) VALUES ($1, $2, $3, $4) RETURNING *',
            [p.sub, body.kind, body.name, JSON.stringify(body.input)],
          )
        ).rows[0]!;
      }
      await this.audit.record(
        {
          actorId: p.sub,
          actorType: 'user',
          action: 'sim.scenario_saved',
          entity: 'sim_scenario',
          entityId: row.id,
          payload: {
            scenarioId: row.id,
            kind: row.kind,
            name: row.name,
            overwritten: !!existing.rows[0],
          },
        },
        c,
      );
      return dto(row);
    });
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete one of your scenarios (audited).' })
  async remove(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.tx(async (c) => {
      const r = await c.query<Row>(
        'DELETE FROM sim_scenarios WHERE id = $1 AND user_id = $2 RETURNING *',
        [id, p.sub],
      );
      if (!r.rows[0])
        throw new NotFoundException({ error: 'not_found', message: 'Scenario not found.' });
      await this.audit.record(
        {
          actorId: p.sub,
          actorType: 'user',
          action: 'sim.scenario_deleted',
          entity: 'sim_scenario',
          entityId: id,
          payload: { scenarioId: id, kind: r.rows[0].kind, name: r.rows[0].name },
        },
        c,
      );
      return { deleted: true, id };
    });
  }
}
