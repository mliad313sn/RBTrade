import { Injectable, NotFoundException } from '@nestjs/common';
import { TIMEFRAME_SECONDS, type InstrumentSpec, type Timeframe } from '@kora/domain';
import { formatPrice, formatSize } from '@kora/market-data';

import { DbService } from '../db/db.service';
import { InstrumentsRepository } from './instruments.repository';

export interface CandleDto {
  /** Bucket start, epoch ms UTC. */
  t: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

export interface CandlesResponse {
  symbol: string;
  tf: Timeframe;
  simulated: boolean;
  source: string;
  candles: CandleDto[];
}

interface Row {
  bucket: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

/**
 * Candle reads. Live buckets come from the md_candles rollup (or md_bars_1s for 1s); SIMULATED
 * history from md_candles_history. A bucket present in both is merged with the OHLCV rules
 * (history precedes live: open from history, close from live, max/min, sums). Output is rounded
 * with the registry precision.
 */
@Injectable()
export class CandlesService {
  constructor(
    private readonly db: DbService,
    private readonly repo: InstrumentsRepository,
  ) {}

  async spec(symbol: string): Promise<InstrumentSpec> {
    const spec = (await this.repo.load()).instruments.get(symbol);
    if (!spec) throw new NotFoundException({ error: 'unknown_symbol', message: `Unknown symbol ${symbol}` });
    return spec;
  }

  async get(q: { symbol: string; tf: Timeframe; limit: number; from?: number; to?: number }): Promise<CandlesResponse> {
    const spec = await this.spec(q.symbol);
    const to = new Date(q.to ?? Date.now() + TIMEFRAME_SECONDS[q.tf] * 1000).toISOString();
    const from = new Date(q.from ?? 0).toISOString();
    const rows =
      q.tf === '1s'
        ? await this.db.query<Row>(
            `SELECT ts AS bucket, open, high, low, close, volume, trades FROM md_bars_1s
             WHERE symbol = $1 AND ts >= $2 AND ts < $3 ORDER BY ts DESC LIMIT $4`,
            [q.symbol, from, to, q.limit],
          )
        : await this.db.query<Row>(
            `WITH h AS (
               SELECT bucket, open, high, low, close, volume, trades, 0 AS src FROM md_candles_history
               WHERE symbol = $1 AND tf = $2 AND bucket >= $3 AND bucket < $4 ORDER BY bucket DESC LIMIT $5
             ), l AS (
               SELECT bucket, open, high, low, close, volume, trades, 1 AS src FROM md_candles
               WHERE symbol = $1 AND tf = $2 AND bucket >= $3 AND bucket < $4 ORDER BY bucket DESC LIMIT $5
             )
             SELECT bucket,
                    (array_agg(open ORDER BY src))[1] AS open, max(high) AS high, min(low) AS low,
                    (array_agg(close ORDER BY src DESC))[1] AS close, sum(volume) AS volume, sum(trades)::int AS trades
             FROM (SELECT * FROM h UNION ALL SELECT * FROM l) u
             GROUP BY bucket ORDER BY bucket DESC LIMIT $5`,
            [q.symbol, q.tf, from, to, q.limit],
          );
    return {
      symbol: q.symbol,
      tf: q.tf,
      simulated: spec.simulated,
      source: spec.simulated ? 'simulated' : 'feed',
      candles: rows.reverse().map((r) => ({
        t: r.bucket.getTime(),
        open: formatPrice(r.open, spec),
        high: formatPrice(r.high, spec),
        low: formatPrice(r.low, spec),
        close: formatPrice(r.close, spec),
        volume: formatSize(r.volume, spec),
        trades: r.trades,
      })),
    };
  }

  /** Current UTC-day open per symbol (for change vs day open in watchlists). */
  async dayOpens(symbols: string[]): Promise<Map<string, string>> {
    if (!symbols.length) return new Map();
    const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
    const rows = await this.db.query<{ symbol: string; open: string }>(
      `SELECT DISTINCT ON (symbol) symbol, open FROM (
         SELECT symbol, open, 0 AS src FROM md_candles_history WHERE tf = '1D' AND bucket = $1 AND symbol = ANY($2)
         UNION ALL
         SELECT symbol, open, 1 FROM md_candles WHERE tf = '1D' AND bucket = $1 AND symbol = ANY($2)
       ) u ORDER BY symbol, src`,
      [day, symbols],
    );
    return new Map(rows.map((r) => [r.symbol, r.open]));
  }
}
