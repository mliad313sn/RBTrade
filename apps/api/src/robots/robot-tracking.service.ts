import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  dec,
  Decimal,
  TIMEFRAME_SECONDS,
  warmupBars,
  type StrategyDefinition,
  type Timeframe,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { ResearchClient } from '../strategies/research-client';
import { ResearchDataService } from '../strategies/research-data.service';
import { AccountsService } from '../trading/accounts.service';
import { TradingRegistryService } from '../trading/trading-registry.service';
import { robotSource, type RobotRow } from './robots.types';
import { loadIntelConfig } from '../intel/intel-config';

const DAY = 86_400_000;

interface BtTrade {
  reason: string;
  entryTs: number;
  exitTs: number;
  netPnl: number;
}

/**
 * Live-vs-backtest tracking error, daily (goal 06 §7). For UTC day D:
 * - live return = the robot's realised P&L net of costs on fills in D, over its allocation;
 * - backtest return = the net P&L of backtest trades (same version, same bars, entered after the
 *   paper start) that closed in D, over the same allocation;
 * - TE(D) = |live − backtest|. The promotion checklist uses the 30-day root mean square.
 * Both sides are on a realised basis, so an open position counts on the day it closes.
 */
@Injectable()
export class RobotTrackingService {
  private readonly log = new Logger('RobotTracking');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly data: ResearchDataService,
    private readonly quant: ResearchClient,
    private readonly accounts: AccountsService,
    private readonly registry: TradingRegistryService,
  ) {}

  private async liveRealised(
    robot: RobotRow,
    from: number,
    to: number,
  ): Promise<{ pnl: Decimal; trades: number }> {
    const fills = await this.db.query<{
      symbol: string;
      side: string;
      qty: string;
      price: string;
      commission: string;
      fx_conversion_cost: string;
      fx_rate: string;
      ts: Date;
    }>(
      `SELECT f.symbol, f.side, f.qty, f.price, f.commission, f.fx_conversion_cost, f.fx_rate, f.ts FROM fills f JOIN orders o ON o.id = f.order_id
       WHERE o.account_id = $1 AND o.source = $2 AND f.ts < $3 ORDER BY f.ts, f.id`,
      [robot.account_id, robotSource(robot.id), new Date(to)],
    );
    const pos = new Map<string, { qty: Decimal; avg: Decimal }>();
    let pnl = new Decimal(0);
    let trades = 0;
    for (const f of fills) {
      const mult = (await this.registry.get(f.symbol)).multiplier;
      const inDay = f.ts.getTime() >= from;
      const q = dec(f.qty).mul(f.side === 'buy' ? 1 : -1);
      const px = dec(f.price);
      if (inDay) pnl = pnl.sub(dec(f.commission)).sub(dec(f.fx_conversion_cost));
      const p = pos.get(f.symbol);
      if (!p || p.qty.isZero()) {
        pos.set(f.symbol, { qty: q, avg: px });
        continue;
      }
      if (p.qty.isPositive() === q.isPositive()) {
        const t = p.qty.add(q);
        p.avg = p.avg.mul(p.qty.abs()).add(px.mul(q.abs())).div(t.abs());
        p.qty = t;
        continue;
      }
      const closing = Decimal.min(p.qty.abs(), q.abs());
      if (inDay) {
        pnl = pnl.add(
          px
            .sub(p.avg)
            .mul(closing)
            .mul(p.qty.isPositive() ? 1 : -1)
            .mul(mult)
            .mul(dec(f.fx_rate)),
        );
        trades += 1;
      }
      const rest = p.qty.add(q);
      pos.set(
        f.symbol,
        rest.isZero() || rest.isPositive() === p.qty.isPositive()
          ? { qty: rest, avg: p.avg }
          : { qty: rest, avg: px },
      );
    }
    return { pnl, trades };
  }

  /** Computes (or recomputes) TE for one robot and UTC day `YYYY-MM-DD`. */
  async computeDay(robotId: string, day: string) {
    const robot = (
      await this.db.query<RobotRow>('SELECT * FROM robots WHERE id = $1', [robotId])
    )[0];
    if (!robot) throw new NotFoundException({ error: 'not_found', message: 'Robot not found.' });
    if (!robot.paper_started_at)
      throw new BadRequestException({
        error: 'not_started',
        message: 'The robot has not paper-traded yet.',
      });
    const from = Date.parse(`${day}T00:00:00Z`);
    const to = from + DAY;
    const start = robot.paper_started_at.getTime();
    if (to <= start)
      throw new BadRequestException({
        error: 'before_paper_start',
        message: 'That day is before the robot started paper trading.',
      });
    const version = (
      await this.db.query<{ id: string; definition: StrategyDefinition }>(
        'SELECT id, definition FROM strategy_versions WHERE id = $1',
        [robot.version_id],
      )
    )[0]!;
    const def = version.definition;
    const account = (await this.accounts.byId(robot.account_id))!;
    const tf = def.universe.timeframe;
    const tfMs = TIMEFRAME_SECONDS[tf as Timeframe] * 1000;
    const warm = warmupBars(def) * tfMs;
    const data = [];
    for (const s of def.universe.symbols)
      data.push(
        await this.data.symbolData(s, tf, account.base_currency, { from: start - warm, to }),
      );
    const usable = data.filter((d) => d.bars.t.length > 0);
    let btPnl = 0;
    let btTrades = 0;
    if (usable.some((d) => d.bars.t.length >= 10)) {
      const res = await this.quant.post<{ trades: BtTrade[] }>('/bt/run', {
        definition: def,
        paramOverrides: {},
        data: usable,
        capital: Number(robot.allocation),
        split: { oosFraction: 0.5 },
        // IRTC R3-18: the tracking error feeds the promotion checklist, so the replay is guarded.
        guard: true,
        maxPoints: 50,
        aiRegime: loadIntelConfig().aiRegime,
      });
      // A position still open at the end of the data is not realised yet (live holds it too).
      for (const t of res.trades)
        if (t.reason !== 'end_of_data' && t.entryTs >= start && t.exitTs >= from && t.exitTs < to) {
          btPnl += t.netPnl;
          btTrades += 1;
        }
    }
    const live = await this.liveRealised(robot, Math.max(from, start), to);
    const alloc = Number(robot.allocation);
    const liveRet = Number(live.pnl.toFixed(10)) / alloc;
    const btRet = btPnl / alloc;
    const te = Math.abs(liveRet - btRet);
    await this.db.query(
      `INSERT INTO robot_tracking (robot_id, day, version_id, live_return, backtest_return, tracking_error, live_trades, backtest_trades)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (robot_id, day) DO UPDATE SET version_id = EXCLUDED.version_id, live_return = EXCLUDED.live_return, backtest_return = EXCLUDED.backtest_return,
         tracking_error = EXCLUDED.tracking_error, live_trades = EXCLUDED.live_trades, backtest_trades = EXCLUDED.backtest_trades, computed_at = clock_timestamp()`,
      [robot.id, day, version.id, liveRet, btRet, te, live.trades, btTrades],
    );
    await this.audit.record({
      actorId: 'robot-tracking',
      actorType: 'system',
      action: 'robot.tracking_computed',
      entity: 'robot',
      entityId: robot.id,
      payload: {
        robotId: robot.id,
        day,
        liveReturn: liveRet.toFixed(8),
        backtestReturn: btRet.toFixed(8),
        trackingError: te.toFixed(8),
        liveTrades: live.trades,
        backtestTrades: btTrades,
      },
    });
    return {
      robotId: robot.id,
      day,
      liveReturn: liveRet,
      backtestReturn: btRet,
      trackingError: te,
      liveTrades: live.trades,
      backtestTrades: btTrades,
    };
  }

  /** Daily job: yesterday (UTC) for every robot that was paper trading. */
  async computeAll(day?: string) {
    const d = day ?? new Date(Date.now() - DAY).toISOString().slice(0, 10);
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM robots WHERE paper_started_at IS NOT NULL AND paper_started_at < ($1::date + 1) AND status IN ('running', 'paused')`,
      [d],
    );
    const out = [];
    for (const r of rows) {
      try {
        out.push(await this.computeDay(r.id, d));
      } catch (e) {
        this.log.warn(`tracking for ${r.id} on ${d} failed: ${(e as Error).message}`);
      }
    }
    return { day: d, robots: out.length, results: out };
  }
}
