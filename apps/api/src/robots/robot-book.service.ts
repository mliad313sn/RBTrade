import { Injectable } from '@nestjs/common';
import { dec, Decimal, quoteChannel, type Quote } from '@kora/domain';

import { DbService, type Queryable } from '../db/db.service';
import { ChannelHub } from '../market-data/channel-hub';
import { FxService } from '../trading/fx.service';
import { TradingRegistryService } from '../trading/trading-registry.service';
import { robotSource, type RobotRow } from './robots.types';

export interface RobotPosition {
  symbol: string;
  /** Signed quantity (long > 0). */
  qty: Decimal;
  avgPrice: Decimal;
  /** First fill of the current position (epoch ms). */
  openedAt: number;
  mark: Decimal | null;
  unrealised: Decimal;
  notional: Decimal;
}

export interface RobotBook {
  positions: RobotPosition[];
  realised: Decimal;
  costs: Decimal;
  unrealised: Decimal;
  equity: Decimal;
  grossExposure: Decimal;
  fills: number;
}

interface FillJoin {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  price: string;
  commission: string;
  fx_conversion_cost: string;
  fx_rate: string;
  ts: Date;
}

const ZERO = new Decimal(0);

/**
 * A robot's own book, from the fills of its orders only (`orders.source = robot:{id}`, bracket
 * children inherit it): average-cost positions, realised P&L in the account currency at each fill's
 * FX rate, commissions and conversion costs, and unrealised P&L at the exit side of the live quote.
 * Robot equity = allocation + realised − costs + unrealised. Overnight funding is booked per account
 * by the paper engine and is not attributed to robots (ADR 0006).
 */
@Injectable()
export class RobotBookService {
  constructor(
    private readonly db: DbService,
    private readonly hub: ChannelHub,
    private readonly registry: TradingRegistryService,
    private readonly fx: FxService,
  ) {}

  async quote(symbol: string): Promise<Quote | null> {
    const [raw] = await this.hub.getLast([quoteChannel(symbol)]);
    return raw ? (JSON.parse(raw) as Quote) : null;
  }

  async book(
    robot: Pick<RobotRow, 'id' | 'account_id' | 'allocation'>,
    baseCcy: string,
    c: Queryable = this.db.pool,
  ): Promise<RobotBook> {
    const fills = (
      await c.query<FillJoin>(
        `SELECT f.symbol, f.side, f.qty, f.price, f.commission, f.fx_conversion_cost, f.fx_rate, f.ts
         FROM fills f JOIN orders o ON o.id = f.order_id
         WHERE o.account_id = $1 AND o.source = $2 ORDER BY f.ts, f.id`,
        [robot.account_id, robotSource(robot.id)],
      )
    ).rows;
    const pos = new Map<string, { qty: Decimal; avg: Decimal; openedAt: number; mult: Decimal }>();
    let realised = ZERO;
    let costs = ZERO;
    for (const f of fills) {
      const inst = await this.registry.get(f.symbol);
      const mult = inst.multiplier;
      const q = dec(f.qty).mul(f.side === 'buy' ? 1 : -1);
      const px = dec(f.price);
      costs = costs.add(dec(f.commission)).add(dec(f.fx_conversion_cost));
      const p = pos.get(f.symbol) ?? { qty: ZERO, avg: ZERO, openedAt: f.ts.getTime(), mult };
      if (p.qty.isZero()) {
        pos.set(f.symbol, { qty: q, avg: px, openedAt: f.ts.getTime(), mult });
        continue;
      }
      if (p.qty.isPositive() === q.isPositive()) {
        const total = p.qty.add(q);
        p.avg = p.avg.mul(p.qty.abs()).add(px.mul(q.abs())).div(total.abs());
        p.qty = total;
        continue;
      }
      const closing = Decimal.min(p.qty.abs(), q.abs());
      const sign = p.qty.isPositive() ? 1 : -1;
      realised = realised.add(px.sub(p.avg).mul(closing).mul(sign).mul(mult).mul(dec(f.fx_rate)));
      const rest = p.qty.add(q);
      if (rest.isZero()) pos.delete(f.symbol);
      else if (rest.isPositive() === p.qty.isPositive()) p.qty = rest;
      else pos.set(f.symbol, { qty: rest, avg: px, openedAt: f.ts.getTime(), mult });
    }
    const positions: RobotPosition[] = [];
    let unrealised = ZERO;
    let gross = ZERO;
    for (const [symbol, p] of pos) {
      const q = await this.quote(symbol);
      const inst = await this.registry.get(symbol);
      const rate = (await this.fx.rate(inst.spec.quoteCcy, baseCcy))?.rate ?? new Decimal(1);
      const mark = q ? dec(p.qty.isPositive() ? q.bid : q.ask) : null;
      const m = mark ?? p.avg;
      const u = m.sub(p.avg).mul(p.qty).mul(p.mult).mul(rate);
      const notional = p.qty.abs().mul(m).mul(p.mult).mul(rate);
      unrealised = unrealised.add(u);
      gross = gross.add(notional);
      positions.push({
        symbol,
        qty: p.qty,
        avgPrice: p.avg,
        openedAt: p.openedAt,
        mark,
        unrealised: u,
        notional,
      });
    }
    const equity = dec(robot.allocation).add(realised).sub(costs).add(unrealised);
    return {
      positions,
      realised,
      costs,
      unrealised,
      equity,
      grossExposure: gross,
      fills: fills.length,
    };
  }

  async ordersLastMinute(
    robot: Pick<RobotRow, 'id' | 'account_id'>,
    c: Queryable = this.db.pool,
  ): Promise<number> {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE account_id = $1 AND source = $2 AND role = 'primary'
       AND created_at > clock_timestamp() - interval '1 minute'`,
      [robot.account_id, robotSource(robot.id)],
    );
    return Number(r.rows[0]!.n);
  }
}
