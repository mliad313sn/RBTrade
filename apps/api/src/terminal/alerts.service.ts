import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  alertTriggered,
  dec,
  quoteChannel,
  rsi,
  type AlertCondition,
  type PriceAlertDto,
  type Quote,
  type Timeframe,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { CandlesService } from '../market-data/candles.service';
import { ChannelHub } from '../market-data/channel-hub';

export interface AlertRow {
  id: string;
  user_id: string;
  symbol: string;
  condition: AlertCondition;
  threshold: string;
  timeframe: string | null;
  note: string | null;
  status: 'active' | 'triggered' | 'cancelled';
  created_at: Date;
  triggered_at: Date | null;
  triggered_value: string | null;
}

/** numeric(38,18) → canonical decimal string without trailing zeros. */
const num = (v: string | null): string | null => (v === null ? null : dec(v).toFixed());

export const toAlertDto = (r: AlertRow): PriceAlertDto => ({
  id: r.id,
  symbol: r.symbol,
  condition: r.condition,
  threshold: num(r.threshold)!,
  timeframe: r.timeframe,
  note: r.note,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  triggeredAt: r.triggered_at?.toISOString() ?? null,
  triggeredValue: num(r.triggered_value),
});

export interface AlertsConfig {
  enabled: boolean;
  evalMs: number;
}

export function loadAlertsConfig(env: NodeJS.ProcessEnv = process.env): AlertsConfig {
  const evalMs = Number(env.KORA_ALERTS_EVAL_MS ?? 1000);
  return {
    enabled: (env.KORA_ALERTS_ENABLED ?? 'true') !== 'false',
    evalMs: Number.isInteger(evalMs) && evalMs >= 100 && evalMs <= 60_000 ? evalMs : 1000,
  };
}

const RSI_PERIOD = 14;
const RSI_BARS = 120;

/**
 * Server-side evaluation of price and indicator alerts (goal 04). Prices are the mid of the goal 02
 * last-value quote (a stale quote never triggers); RSI uses the shared indicator library on the
 * same candles the chart shows. An alert triggers once, atomically, and is audited as
 * `alert.triggered` by the system actor `alerts-evaluator`.
 */
@Injectable()
export class AlertsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(AlertsService.name);
  private readonly cfg = loadAlertsConfig();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly hub: ChannelHub,
    private readonly candles: CandlesService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.enabled) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.evaluateOnce()
        .catch((e: Error) => this.log.warn(`alert evaluation failed: ${e.message}`))
        .finally(() => (this.running = false));
    }, this.cfg.evalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One evaluation pass. Returns the alerts that triggered. Public for tests. */
  async evaluateOnce(now = Date.now()): Promise<PriceAlertDto[]> {
    const active = await this.db.query<AlertRow>(
      `SELECT id, user_id, symbol, condition, threshold::text AS threshold, timeframe, note, status, created_at, triggered_at, triggered_value::text AS triggered_value
         FROM price_alerts WHERE status = 'active' ORDER BY created_at LIMIT 5000`,
    );
    if (!active.length) return [];
    const symbols = [...new Set(active.map((a) => a.symbol))];
    const raw = await this.hub.getLast(symbols.map(quoteChannel));
    const mids = new Map<string, ReturnType<typeof dec>>();
    raw.forEach((r, i) => {
      if (!r) return;
      const q = JSON.parse(r) as Quote;
      if (q.stale) return;
      mids.set(symbols[i]!, dec(q.bid).add(dec(q.ask)).div(2));
    });
    const rsiCache = new Map<string, number | null>();
    const triggered: PriceAlertDto[] = [];
    for (const a of active) {
      let value: ReturnType<typeof dec> | number | null = null;
      if (a.condition === 'price_above' || a.condition === 'price_below') {
        value = mids.get(a.symbol) ?? null;
      } else {
        const key = `${a.symbol}|${a.timeframe}`;
        if (!rsiCache.has(key))
          rsiCache.set(key, await this.latestRsi(a.symbol, a.timeframe as Timeframe));
        value = rsiCache.get(key) ?? null;
      }
      if (value === null || !alertTriggered(a.condition, a.threshold, value)) continue;
      const shown = typeof value === 'number' ? value.toFixed(2) : value.toFixed();
      const row = await this.db.tx(async (c) => {
        const r = await c.query<AlertRow>(
          `UPDATE price_alerts SET status = 'triggered', triggered_at = to_timestamp($3 / 1000.0), triggered_value = $2::numeric
             WHERE id = $1 AND status = 'active'
             RETURNING id, user_id, symbol, condition, threshold::text AS threshold, timeframe, note, status, created_at, triggered_at, triggered_value::text AS triggered_value`,
          [a.id, shown, now],
        );
        const updated = r.rows[0];
        if (!updated) return null;
        await this.audit.record(
          {
            actorId: 'alerts-evaluator',
            actorType: 'system',
            action: 'alert.triggered',
            entity: 'price_alert',
            entityId: a.id,
            payload: {
              userId: a.user_id,
              symbol: a.symbol,
              condition: a.condition,
              threshold: num(a.threshold)!,
              value: shown,
              timeframe: a.timeframe,
              environment: 'PAPER',
            },
          },
          c,
        );
        return updated;
      });
      if (row) triggered.push(toAlertDto(row));
    }
    return triggered;
  }

  private async latestRsi(symbol: string, tf: Timeframe): Promise<number | null> {
    const { candles } = await this.candles.get({ symbol, tf, limit: RSI_BARS });
    const closes = candles.map((c) => Number(c.close));
    const series = rsi(closes, RSI_PERIOD);
    return series.length ? (series[series.length - 1] ?? null) : null;
  }
}
