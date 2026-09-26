import {
  BadRequestException,
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
  Put,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateWatchlistSchema,
  MAX_WATCHLISTS_PER_USER,
  UpdateWatchlistSchema,
  type WatchlistDto,
} from '@kora/domain';
import type { PoolClient } from 'pg';
import type { z } from 'zod';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';
import { InstrumentsRepository } from '../market-data/instruments.repository';

interface Row {
  id: string;
  name: string;
  position: number;
  symbols: string[];
  updated_at: Date;
}

/** Prototype list ("Watchlist · Majors"), in artboard order. */
export const MAJORS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'XAUUSD',
  'BTCUSD',
  'ETHUSD',
  'US500',
  'NAS100',
  'AAPL',
  'NVDA',
  'WTI',
];
const REGION_ORDER = [
  'north_america',
  'south_america',
  'europe',
  'africa',
  'asia',
  'oceania',
  'global',
];

const toDto = (r: Row): WatchlistDto => ({
  id: r.id,
  name: r.name,
  position: r.position,
  symbols: r.symbols,
  updatedAt: r.updated_at.toISOString(),
});

/**
 * Pro terminal watchlists (goal 04). A new user gets "Majors" (the prototype list) and "Global"
 * (one active instrument per registry venue, ordered by region), so the terminal covers every
 * continent from the first login. Symbols are validated against the instrument registry.
 */
@ApiTags('terminal')
@Controller('me/watchlists')
export class WatchlistsController {
  constructor(
    private readonly db: DbService,
    private readonly registry: InstrumentsRepository,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The user’s watchlists (created with the Majors and Global defaults on first read).',
  })
  async list(@CurrentPrincipal() p: Principal) {
    const rows = await this.rows(p.sub);
    if (rows.length) return { watchlists: rows.map(toDto) };
    const defaults = await this.defaults();
    await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`watchlists:${p.sub}`]);
      const again = await c.query('SELECT 1 FROM watchlists WHERE user_id = $1 LIMIT 1', [p.sub]);
      if (again.rowCount) return;
      for (const [i, d] of defaults.entries()) {
        await c.query(
          'INSERT INTO watchlists (user_id, name, position, symbols) VALUES ($1, $2, $3, $4)',
          [p.sub, d.name, i, d.symbols],
        );
      }
    });
    return { watchlists: (await this.rows(p.sub)).map(toDto) };
  }

  @Post()
  @ApiOperation({ summary: 'Create a watchlist (≤ 20 per user, ≤ 500 symbols each).' })
  @ApiBody({ schema: openApiSchema(CreateWatchlistSchema) })
  async create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(CreateWatchlistSchema)) body: z.infer<typeof CreateWatchlistSchema>,
  ) {
    await this.validateSymbols(body.symbols);
    return this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`watchlists:${p.sub}`]);
      const n = await c.query<{ n: number; max: number | null }>(
        'SELECT count(*)::int AS n, max(position) AS max FROM watchlists WHERE user_id = $1',
        [p.sub],
      );
      if (n.rows[0]!.n >= MAX_WATCHLISTS_PER_USER)
        throw new BadRequestException({
          error: 'too_many_watchlists',
          message: `You can have up to ${MAX_WATCHLISTS_PER_USER} watchlists.`,
        });
      const r = await this.insert(c, p.sub, body.name, (n.rows[0]!.max ?? -1) + 1, body.symbols);
      return toDto(r);
    });
  }

  @Put(':id')
  @ApiOperation({ summary: 'Rename, reorder symbols (drag or add/remove) or move a watchlist.' })
  @ApiBody({ schema: openApiSchema(UpdateWatchlistSchema) })
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateWatchlistSchema)) body: z.infer<typeof UpdateWatchlistSchema>,
  ) {
    if (body.symbols) await this.validateSymbols(body.symbols);
    try {
      const rows = await this.db.query<Row>(
        `UPDATE watchlists SET name = COALESCE($3, name), symbols = COALESCE($4, symbols), position = COALESCE($5, position), updated_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING id, name, position, symbols, updated_at`,
        [id, p.sub, body.name ?? null, body.symbols ?? null, body.position ?? null],
      );
      if (!rows[0])
        throw new NotFoundException({ error: 'not_found', message: 'Watchlist not found.' });
      return toDto(rows[0]);
    } catch (e) {
      throw uniqueName(e);
    }
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a watchlist.' })
  async remove(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    const rows = await this.db.query(
      'DELETE FROM watchlists WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, p.sub],
    );
    if (!rows.length)
      throw new NotFoundException({ error: 'not_found', message: 'Watchlist not found.' });
  }

  private rows(userId: string): Promise<Row[]> {
    return this.db.query<Row>(
      'SELECT id, name, position, symbols, updated_at FROM watchlists WHERE user_id = $1 ORDER BY position, name',
      [userId],
    );
  }

  private async insert(
    c: PoolClient,
    userId: string,
    name: string,
    position: number,
    symbols: string[],
  ): Promise<Row> {
    try {
      const r = await c.query<Row>(
        'INSERT INTO watchlists (user_id, name, position, symbols) VALUES ($1, $2, $3, $4) RETURNING id, name, position, symbols, updated_at',
        [userId, name, position, symbols],
      );
      return r.rows[0]!;
    } catch (e) {
      throw uniqueName(e);
    }
  }

  private async validateSymbols(symbols: string[]): Promise<void> {
    const reg = await this.registry.load();
    const unknown = symbols.filter((s) => !reg.instruments.has(s));
    if (unknown.length)
      throw new BadRequestException({
        error: 'unknown_symbol',
        message: `Unknown symbol${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).join(', ')}`,
      });
  }

  /** Majors (prototype) + Global: the first active instrument of every venue, by region. */
  async defaults(): Promise<Array<{ name: string; symbols: string[] }>> {
    const reg = await this.registry.load();
    const majors = MAJORS.filter((s) => reg.instruments.has(s));
    const byVenue = new Map<string, string>();
    for (const spec of [...reg.instruments.values()]
      .filter((s) => s.status === 'active')
      .sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      if (!byVenue.has(spec.venue)) byVenue.set(spec.venue, spec.symbol);
    }
    const venues = [...reg.venues.values()].sort(
      (a, b) =>
        REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region) ||
        a.mic.localeCompare(b.mic),
    );
    const global = venues.map((v) => byVenue.get(v.mic)).filter((s): s is string => Boolean(s));
    return [
      { name: 'Majors', symbols: majors },
      { name: 'Global', symbols: global },
    ];
  }
}

function uniqueName(e: unknown): unknown {
  if ((e as { code?: string }).code === '23505')
    return new ConflictException({
      error: 'name_taken',
      message: 'You already have a watchlist with that name.',
    });
  return e;
}
