import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  ASSET_CLASSES,
  assetClassLabel,
  MIC_RE,
  REGIONS,
  sessionStatus,
  SYMBOL_RE,
  type InstrumentSpec,
  type Venue,
} from '@kora/domain';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod';
import { InstrumentsRepository, type Registry } from './instruments.repository';

const ListQuery = z
  .object({
    assetClass: z.enum(ASSET_CLASSES).optional(),
    venue: z.string().regex(MIC_RE).optional(),
    region: z.enum(REGIONS).optional(),
    q: z.string().max(40).optional(),
  })
  .strict();

function sessionOf(spec: InstrumentSpec, reg: Registry, now: number) {
  const o = spec.tradingSessions;
  const venue = reg.venues.get(spec.venue);
  if (o)
    return {
      ...sessionStatus(o, o.timezone, now),
      timezone: o.timezone,
      source: 'instrument' as const,
    };
  if (!venue) return null;
  return {
    ...sessionStatus(venue.calendar, venue.timezone, now),
    timezone: venue.timezone,
    source: 'venue' as const,
  };
}

const venueDto = (v: Venue, now: number) => ({
  ...v,
  session: sessionStatus(v.calendar, v.timezone, now),
});

@ApiTags('market-data')
@Controller()
export class InstrumentsController {
  constructor(private readonly repo: InstrumentsRepository) {}

  @Get('instruments')
  @ApiOperation({
    summary:
      'Instrument registry (SIMULATED seed). Precision, tick, qty step and sessions for every instrument.',
  })
  @ApiQuery({ name: 'assetClass', required: false, enum: ASSET_CLASSES })
  @ApiQuery({ name: 'venue', required: false, description: 'ISO 10383 MIC' })
  @ApiQuery({ name: 'region', required: false, enum: REGIONS })
  @ApiQuery({ name: 'q', required: false, description: 'symbol or name contains' })
  async list(@Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    const reg = await this.repo.load();
    const now = Date.now();
    const needle = q.q?.toLowerCase();
    const items = [...reg.instruments.values()].filter((i) => {
      const v = reg.venues.get(i.venue);
      return (
        (!q.assetClass || i.assetClass === q.assetClass) &&
        (!q.venue || i.venue === q.venue) &&
        (!q.region || v?.region === q.region) &&
        (!needle ||
          i.symbol.toLowerCase().includes(needle) ||
          i.displayName.toLowerCase().includes(needle))
      );
    });
    return {
      instruments: items.map((i) => ({
        ...i,
        assetClassLabel: assetClassLabel(i.assetClass, i.underlyingClass),
        session: sessionOf(i, reg, now),
      })),
    };
  }

  @Get('instruments/:symbol')
  @ApiOperation({ summary: 'One instrument with its venue and current session status.' })
  async one(@Param('symbol') symbol: string) {
    const reg = await this.repo.load();
    const spec = SYMBOL_RE.test(symbol) ? reg.instruments.get(symbol) : undefined;
    if (!spec)
      throw new NotFoundException({ error: 'unknown_symbol', message: `Unknown symbol ${symbol}` });
    const now = Date.now();
    const venue = reg.venues.get(spec.venue);
    return {
      ...spec,
      assetClassLabel: assetClassLabel(spec.assetClass, spec.underlyingClass),
      staleAfterMs: reg.staleAfterMs.get(spec.assetClass) ?? null,
      venueInfo: venue ? venueDto(venue, now) : null,
      session: sessionOf(spec, reg, now),
    };
  }

  @Get('venues')
  @ApiOperation({
    summary: 'Venues (ISO 10383 MIC; SIMULATED sample calendars) with current session status.',
  })
  async venues() {
    const reg = await this.repo.load();
    const now = Date.now();
    return { venues: [...reg.venues.values()].map((v) => venueDto(v, now)) };
  }

  @Get('venues/:mic')
  @ApiOperation({ summary: 'One venue with its calendar and current session status.' })
  async venue(@Param('mic') mic: string) {
    const v = MIC_RE.test(mic) ? (await this.repo.load()).venues.get(mic) : undefined;
    if (!v)
      throw new NotFoundException({ error: 'unknown_venue', message: `Unknown venue ${mic}` });
    return venueDto(v, Date.now());
  }
}
