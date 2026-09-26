import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  LAYOUT_NAME_RE,
  MAX_LAYOUT_BYTES,
  MAX_LAYOUTS_PER_USER,
  SaveLayoutSchema,
} from '@kora/domain';
import type { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';

interface LayoutRow {
  name: string;
  layout: Record<string, unknown>;
  updated_at: Date;
}

function layoutName(raw: string): string {
  const name = decodeURIComponent(raw).trim();
  if (!LAYOUT_NAME_RE.test(name)) {
    throw new BadRequestException({
      error: 'invalid_name',
      message: 'Use up to 40 letters, digits, spaces, dot, dash or underscore.',
    });
  }
  return name;
}

/**
 * Named Pro terminal layouts per user (goal 04). The layout is dockview's JSON, opaque to the api
 * apart from its size (≤ 64 KB) and count (≤ 20 per user). Not audited: UI state, not a trading
 * action (ADR 0004).
 */
@ApiTags('terminal')
@Controller('me/layouts')
export class LayoutsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @ApiOperation({ summary: 'Saved terminal layouts (names and JSON), most recently saved first.' })
  async list(@CurrentPrincipal() p: Principal) {
    const rows = await this.db.query<LayoutRow>(
      'SELECT name, layout, updated_at FROM user_layouts WHERE user_id = $1 ORDER BY updated_at DESC, name',
      [p.sub],
    );
    return {
      layouts: rows.map((r) => ({
        name: r.name,
        layout: r.layout,
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }

  @Put(':name')
  @ApiOperation({ summary: 'Save (create or replace) a named layout.' })
  @ApiBody({ schema: openApiSchema(SaveLayoutSchema) })
  async save(
    @CurrentPrincipal() p: Principal,
    @Param('name') rawName: string,
    @Body(new ZodValidationPipe(SaveLayoutSchema)) body: z.infer<typeof SaveLayoutSchema>,
  ) {
    const name = layoutName(rawName);
    const json = JSON.stringify(body.layout);
    if (Buffer.byteLength(json) > MAX_LAYOUT_BYTES)
      throw new BadRequestException({
        error: 'layout_too_large',
        message: 'A layout can be at most 64 KB.',
      });
    return this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`layouts:${p.sub}`]);
      const count = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM user_layouts WHERE user_id = $1 AND name <> $2',
        [p.sub, name],
      );
      if (count.rows[0]!.n >= MAX_LAYOUTS_PER_USER) {
        throw new BadRequestException({
          error: 'too_many_layouts',
          message: `You can save up to ${MAX_LAYOUTS_PER_USER} layouts. Delete one first.`,
        });
      }
      const r = await c.query<LayoutRow>(
        `INSERT INTO user_layouts (user_id, name, layout, updated_at) VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (user_id, name) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()
         RETURNING name, layout, updated_at`,
        [p.sub, name, json],
      );
      const row = r.rows[0]!;
      return { name: row.name, layout: row.layout, updatedAt: row.updated_at.toISOString() };
    });
  }

  @Delete(':name')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a named layout.' })
  async remove(@CurrentPrincipal() p: Principal, @Param('name') rawName: string) {
    const rows = await this.db.query(
      'DELETE FROM user_layouts WHERE user_id = $1 AND name = $2 RETURNING name',
      [p.sub, layoutName(rawName)],
    );
    if (!rows.length)
      throw new NotFoundException({ error: 'not_found', message: 'No layout with that name.' });
  }
}
