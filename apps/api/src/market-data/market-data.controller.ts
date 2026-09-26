import { ConflictException, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { depthChannel, quoteChannel, SYMBOL_RE, TIMEFRAMES, type DepthSnapshot, type Quote } from '@kora/domain';
import { SimulatedCalendarProvider } from '@kora/market-data';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod';
import { CandlesService } from './candles.service';
import { ChannelHub } from './channel-hub';
import { FeedService } from './feed.service';
import { MarketDataGateway } from './gateway';
import { MD_CONFIG, type MdConfig } from './md-config';

const instant = z.union([
  z.coerce.number().int().nonnegative().max(8_640_000_000_000),
  z.iso.datetime({ offset: true }).transform((s) => Date.parse(s)),
]);
const symbol = z.string().regex(SYMBOL_RE);

const CandlesQuery = z
  .object({ symbol, tf: z.enum(TIMEFRAMES), limit: z.coerce.number().int().min(1).max(5000).default(500), from: instant.optional(), to: instant.optional() })
  .strict();
const QuotesQuery = z
  .object({
    symbols: z
      .string()
      .max(4000)
      .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
      .pipe(z.array(symbol).min(1).max(200)),
  })
  .strict();
const CalendarQuery = z.object({ from: instant.optional(), to: instant.optional() }).strict();
const DAY = 86_400_000;

@ApiTags('market-data')
@Controller()
export class MarketDataController {
  private readonly calendar: SimulatedCalendarProvider;

  constructor(
    private readonly candles: CandlesService,
    private readonly hub: ChannelHub,
    private readonly feed: FeedService,
    private readonly gateway: MarketDataGateway,
    private readonly audit: AuditService,
    @Inject(MD_CONFIG) private readonly cfg: MdConfig,
  ) {
    this.calendar = new SimulatedCalendarProvider(cfg.seed);
  }

  @Get('candles')
  @ApiOperation({ summary: 'OHLCV candles, oldest first, registry precision. SIMULATED data.' })
  @ApiQuery({ name: 'symbol', required: true, example: 'EURUSD' })
  @ApiQuery({ name: 'tf', required: true, enum: TIMEFRAMES })
  @ApiQuery({ name: 'limit', required: false, example: 500 })
  @ApiQuery({ name: 'from', required: false, description: 'epoch ms or ISO-8601, inclusive' })
  @ApiQuery({ name: 'to', required: false, description: 'epoch ms or ISO-8601, exclusive' })
  getCandles(@Query(new ZodValidationPipe(CandlesQuery)) q: z.infer<typeof CandlesQuery>) {
    return this.candles.get(q);
  }

  @Get('quotes')
  @ApiOperation({ summary: 'Last quote per symbol (with stale flag) and the UTC day open.' })
  @ApiQuery({ name: 'symbols', required: true, example: 'EURUSD,GBPUSD' })
  async quotes(@Query(new ZodValidationPipe(QuotesQuery)) q: z.infer<typeof QuotesQuery>) {
    const last = await this.hub.getLast(q.symbols.map(quoteChannel));
    const opens = await this.candles.dayOpens(q.symbols);
    const lost = this.hub.stats().feedLost;
    return {
      quotes: q.symbols.map((s, i) => {
        const quote = last[i] ? (JSON.parse(last[i]!) as Quote) : null;
        return { symbol: s, quote: quote && lost ? { ...quote, stale: true } : quote, dayOpen: opens.get(s) ?? null };
      }),
    };
  }

  @Get('depth/:symbol')
  @ApiOperation({ summary: 'Last L2 depth snapshot for a symbol.' })
  async depth(@Param('symbol') s: string) {
    await this.candles.spec(s);
    const [d] = await this.hub.getLast([depthChannel(s)]);
    return { symbol: s, depth: d ? (JSON.parse(d) as DepthSnapshot) : null };
  }

  @Get('market-data/status')
  @ApiOperation({ summary: 'Feed status (as published on the status channel) and gateway counters.' })
  status() {
    return {
      status: this.feed.isRunning ? this.feed.status() : this.hub.lastStatus(),
      gateway: { ...this.hub.stats(), connections: this.gateway.connectionCount },
      feedMode: this.cfg.feed,
    };
  }

  @Get('calendar')
  @ApiOperation({ summary: 'Economic calendar (SIMULATED provider; times and events are invented). Max 31 days.' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async events(@Query(new ZodValidationPipe(CalendarQuery)) q: z.infer<typeof CalendarQuery>) {
    const from = q.from ?? Math.floor(Date.now() / DAY) * DAY;
    const to = Math.min(q.to ?? from + 7 * DAY, from + 31 * DAY);
    return { source: this.calendar.source, simulated: true, events: await this.calendar.getEvents(from, to) };
  }

  @Post('market-data/feeds/:source/stop')
  @HttpCode(202)
  @Roles('admin')
  @ApiOperation({ summary: 'Stop a feed adapter (ops/chaos drill). Admin only, audited.' })
  async stop(@CurrentPrincipal() p: Principal, @Param('source') source: string) {
    return this.control(p, source, 'stop');
  }

  @Post('market-data/feeds/:source/start')
  @HttpCode(202)
  @Roles('admin')
  @ApiOperation({ summary: 'Start a stopped feed adapter (resyncs on the resulting gap). Admin only, audited.' })
  async start(@CurrentPrincipal() p: Principal, @Param('source') source: string) {
    return this.control(p, source, 'start');
  }

  private async control(p: Principal, source: string, action: 'stop' | 'start') {
    if (!this.feed.isRunning) throw new ConflictException({ error: 'feed_not_in_process', message: 'The feed runs in another process (KORA_MD_FEED=off)' });
    if (action === 'stop') await this.feed.stopAdapter(source);
    else await this.feed.startAdapter(source);
    const event = await this.audit.record({
      actorId: p.sub,
      actorType: 'user',
      action: action === 'stop' ? 'market_data.feed_stopped' : 'market_data.feed_started',
      entity: 'market_data_feed',
      entityId: source,
      payload: { source, environment: 'PAPER' },
    });
    return { source, action, auditEventId: event.id };
  }
}
