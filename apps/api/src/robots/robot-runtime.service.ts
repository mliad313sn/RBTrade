import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  bucketStart,
  dec,
  Decimal,
  hasAnyRole,
  ROBOT_BUILDER_ROLES,
  roundToTick,
  TIMEFRAME_SECONDS,
  warmupBars,
  type JsonValue,
  type PlaceOrderRequest,
  type StrategyDefinition,
  type Timeframe,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { UsersRepository } from '../auth/users.repository';
import { DbService } from '../db/db.service';
import { ResearchDataService } from '../strategies/research-data.service';
import { AccountsService } from '../trading/accounts.service';
import { FxService } from '../trading/fx.service';
import { OmsService, RiskRejection } from '../trading/oms.service';
import { TradingRegistryService } from '../trading/trading-registry.service';
import type { OrderRow } from '../trading/trading.types';
import type { Actor } from '../trading/tx';
import { RobotBookService } from './robot-book.service';
import { RobotsService, signalDto } from './robots.service';
import { robotSource, type RobotJoinRow } from './robots.types';
import { loadIntelConfig } from '../intel/intel-config';

/** What quant `/bt/signal` returns (the runner forwards it unchanged). */
export interface SignalResult {
  symbol: string;
  barTs: number;
  action: 'enter_long' | 'enter_short' | 'exit' | 'hold' | 'blocked';
  reason: string;
  conditions: JsonValue[];
  qty: string | null;
  stopDistance: number | null;
  targetDistance: number | null;
  newStop: string | null;
  features: Record<string, number | null>;
  params: Record<string, number>;
}

interface EntryDetail {
  refPrice: string;
  stopPrice: string;
  targetPrice: string | null;
  stopDistance: string;
}

interface Outcome {
  o: 'none' | 'submitted' | 'rejected' | 'refused';
  d: Record<string, JsonValue>;
  orderId?: string | null;
}

const tfMs = (tf: string) => TIMEFRAME_SECONDS[tf as Timeframe] * 1000;

/**
 * Server side of the bot runner (B-301). The runner authenticates with the service token; every
 * call resolves robot → owner → account here, so a runner can never act for another user. Orders go
 * through `OmsService.submit` with actor `robot` and source `robot:{id}` — the same path as humans
 * (risk, audit, idempotency on the client order id).
 */
@Injectable()
export class RobotRuntimeService {
  private readonly log = new Logger('RobotRuntime');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly robots: RobotsService,
    private readonly book: RobotBookService,
    private readonly data: ResearchDataService,
    private readonly oms: OmsService,
    private readonly users: UsersRepository,
    private readonly registry: TradingRegistryService,
    private readonly accounts: AccountsService,
    private readonly fx: FxService,
  ) {}

  async running() {
    const rows = await this.db.query<{
      id: string;
      account_id: string;
      version_id: string;
      timeframe: string;
      symbols: string[];
    }>(
      `SELECT r.id, r.account_id, r.version_id, v.definition->'universe'->>'timeframe' AS timeframe,
         ARRAY(SELECT jsonb_array_elements_text(v.definition->'universe'->'symbols')) AS symbols
       FROM robots r JOIN strategy_versions v ON v.id = r.version_id WHERE r.status = 'running' AND r.mode = 'PAPER'`,
    );
    return {
      robots: rows.map((r) => ({
        robotId: r.id,
        accountId: r.account_id,
        versionId: r.version_id,
        timeframe: r.timeframe,
        symbols: r.symbols,
      })),
    };
  }

  private async runningRobot(
    robotId: string,
  ): Promise<RobotJoinRow & { definition: StrategyDefinition }> {
    const r = await this.robots.row(robotId);
    if (!r || r.status !== 'running' || r.mode !== 'PAPER')
      throw new ConflictException({
        error: 'robot_not_running',
        message: 'The robot is not running.',
        status: r?.status ?? null,
      });
    const v = await this.db.query<{ definition: StrategyDefinition }>(
      'SELECT definition FROM strategy_versions WHERE id = $1',
      [r.version_id],
    );
    return { ...r, definition: v[0]!.definition };
  }

  /** Everything `/bt/signal` needs for the bar that just closed (point-in-time: bars ≤ barTs). */
  async context(robotId: string, symbol: string, barTs: number) {
    const r = await this.runningRobot(robotId);
    const def = r.definition;
    if (!def.universe.symbols.includes(symbol))
      throw new BadRequestException({
        error: 'symbol_not_in_strategy',
        message: `${symbol} is not traded by this robot.`,
      });
    const account = (await this.accounts.byId(r.account_id))!;
    const tf = def.universe.timeframe;
    const window = Math.min(2000, Math.max(300, warmupBars(def) * 3));
    const data = await this.data.symbolData(symbol, tf, account.base_currency, {
      to: barTs + tfMs(tf),
      limit: window,
    });
    const last = data.bars.t[data.bars.t.length - 1];
    if (last !== barTs)
      throw new ConflictException({
        error: 'bar_not_ready',
        message: 'That bar is not in the candle store yet.',
        lastBar: last ?? null,
      });
    const b = await this.book.book(r, account.base_currency);
    const p = b.positions.find((x) => x.symbol === symbol);
    let position: Record<string, unknown> | null = null;
    if (p) {
      const entry = await this.lastEntry(robotId, symbol);
      const stopOrder = await this.workingChild(r, symbol, 'stop_loss');
      const entryBar = bucketStart(p.openedAt, tf as Timeframe);
      const since = data.bars.t
        .map((t, i) => [t, data.bars.c[i]!] as const)
        .filter(([t]) => t >= entryBar);
      const ref = entry ? Number(entry.refPrice) : Number(p.avgPrice.toFixed());
      const prior = since.slice(0, -1).map(([, c]) => c);
      const long = p.qty.isPositive();
      const stop = stopOrder?.stop_price ?? entry?.stopPrice ?? null;
      position = {
        side: long ? 'long' : 'short',
        qty: p.qty.abs().toFixed(),
        entryRef: ref,
        stop: stop === null ? (long ? 0 : ref * 10) : Number(stop),
        initialStop: entry ? Number(entry.stopPrice) : stop === null ? 0 : Number(stop),
        target: entry?.targetPrice ? Number(entry.targetPrice) : null,
        barsHeld: since.length,
        highWater: long ? Math.max(ref, ...prior) : Math.min(ref, ...prior),
      };
    }
    return {
      robotId,
      versionId: r.version_id,
      symbol,
      barTs,
      signalRequest: {
        definition: def,
        paramOverrides: {},
        data,
        position,
        equity: Number(b.equity.toFixed(2)),
        openPositions: b.positions.length,
        aiRegime: loadIntelConfig().aiRegime,
      },
    };
  }

  private async lastEntry(robotId: string, symbol: string): Promise<EntryDetail | null> {
    const r = await this.db.query<{ outcome_detail: EntryDetail }>(
      `SELECT outcome_detail FROM robot_signals WHERE robot_id = $1 AND symbol = $2 AND action IN ('enter_long', 'enter_short') AND outcome = 'submitted'
       ORDER BY bar_ts DESC LIMIT 1`,
      [robotId, symbol],
    );
    return r[0]?.outcome_detail ?? null;
  }

  private async workingChild(
    r: RobotJoinRow,
    symbol: string,
    role: 'stop_loss' | 'take_profit',
  ): Promise<OrderRow | null> {
    const rows = await this.db.query<OrderRow>(
      `SELECT * FROM orders WHERE account_id = $1 AND symbol = $2 AND source = $3 AND role = $4 AND status IN ('working', 'partially_filled', 'accepted', 'new')
       ORDER BY created_at DESC LIMIT 1`,
      [r.account_id, symbol, robotSource(r.id), role],
    );
    return rows[0] ?? null;
  }

  /**
   * Records the decision and acts on it through the OMS. Idempotent per (robot, symbol, bar): a
   * replayed job returns the stored signal and never submits twice (the client order id is derived
   * from the bar as a second guard).
   */
  async decision(
    robotId: string,
    body: { symbol: string; barTs: number; versionId: string; signal: SignalResult },
  ) {
    const existing = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM robot_signals WHERE robot_id = $1 AND symbol = $2 AND bar_ts = $3',
      [robotId, body.symbol, new Date(body.barTs)],
    );
    if (existing[0]) return { ...signalDto(existing[0]), replay: true };
    const r = await this.runningRobot(robotId);
    if (r.version_id !== body.versionId)
      throw new ConflictException({
        error: 'version_changed',
        message: 'The robot now runs another version; this decision is stale.',
      });
    if (body.signal.barTs !== body.barTs || body.signal.symbol !== body.symbol)
      throw new BadRequestException({
        error: 'signal_mismatch',
        message: 'The signal does not match the bar.',
      });
    const account = (await this.accounts.byId(r.account_id))!;
    const roles = await this.users.roles(r.owner_id);
    const actor: Actor = { type: 'robot', id: robotId };
    let outcome: 'none' | 'submitted' | 'rejected' | 'refused' = 'none';
    let detail: Record<string, JsonValue> = {};
    let orderId: string | null = null;
    const s = body.signal;
    const act = async (): Promise<Outcome> => {
      if (!hasAnyRole(roles, ROBOT_BUILDER_ROLES)) {
        await this.robots.pauseRobot(
          robotId,
          'owner_role_revoked',
          { type: 'system', id: 'robot-runtime' },
          {},
          {
            severity: 'warning',
            message: 'Robot paused: its owner no longer holds a trader, quant or admin role.',
          },
        );
        return { o: 'refused' as const, d: { code: 'OWNER_ROLE_REVOKED' } };
      }
      if (account.trading_halted) return { o: 'refused' as const, d: { code: 'TRADING_HALTED' } };
      if (s.action === 'enter_long' || s.action === 'enter_short')
        return this.enter(r, account.base_currency, roles, actor, s);
      if (s.action === 'exit') return this.exit(r, account.base_currency, roles, actor, s);
      if (s.action === 'hold' && s.newStop) return this.trail(r, roles, actor, s);
      return { o: 'none' as const, d: {} };
    };
    const res = await act();
    outcome = res.o;
    detail = res.d;
    orderId = res.orderId ?? null;
    const row = (
      await this.db.query<Record<string, unknown>>(
        `INSERT INTO robot_signals (robot_id, version_id, symbol, bar_ts, action, reason, conditions, features, outcome, outcome_detail, order_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (robot_id, symbol, bar_ts) DO NOTHING RETURNING *`,
        [
          robotId,
          r.version_id,
          body.symbol,
          new Date(body.barTs),
          s.action,
          s.reason,
          JSON.stringify(s.conditions),
          JSON.stringify(s.features),
          outcome,
          JSON.stringify(detail),
          orderId,
        ],
      )
    )[0];
    if (!row) {
      const again = await this.db.query<Record<string, unknown>>(
        'SELECT * FROM robot_signals WHERE robot_id = $1 AND symbol = $2 AND bar_ts = $3',
        [robotId, body.symbol, new Date(body.barTs)],
      );
      return { ...signalDto(again[0]!), replay: true };
    }
    if (s.action !== 'hold' || outcome !== 'none')
      await this.audit.record({
        actorId: robotId,
        actorType: 'robot',
        action: 'robot.signal',
        entity: 'robot',
        entityId: robotId,
        payload: {
          robotId,
          signalId: row.id as string,
          symbol: body.symbol,
          barTs: new Date(body.barTs).toISOString(),
          action: s.action,
          reason: s.reason,
          outcome,
          orderId,
          versionId: r.version_id,
          ...(detail.code ? { code: detail.code } : {}),
        },
      });
    return { ...signalDto(row), replay: false };
  }

  private submitter(
    r: RobotJoinRow,
    roles: Awaited<ReturnType<UsersRepository['roles']>>,
    actor: Actor,
  ) {
    return { userId: r.owner_id, roles, actor, source: robotSource(r.id) };
  }

  private coid(prefix: string, r: RobotJoinRow, symbol: string, barTs: number): string {
    return `${prefix}:${r.id.slice(0, 8)}:${symbol.replace(/[^A-Za-z0-9._-]/g, '-')}:${barTs}`.slice(
      0,
      64,
    );
  }

  private async submit(
    r: RobotJoinRow,
    roles: Awaited<ReturnType<UsersRepository['roles']>>,
    actor: Actor,
    req: PlaceOrderRequest,
  ): Promise<Outcome> {
    try {
      const out = await this.oms.submit(this.submitter(r, roles, actor), req);
      const status = out.order.status;
      if (status === 'rejected')
        return {
          o: 'rejected' as const,
          d: { code: out.order.rejectCode ?? 'REJECTED' },
          orderId: out.order.id,
        };
      return {
        o: 'submitted',
        d: { status, clientOrderId: req.clientOrderId },
        orderId: out.order.id,
      };
    } catch (err) {
      if (err instanceof RiskRejection) {
        const body = err.getResponse() as {
          code?: string;
          message?: string;
          order?: { id: string };
        };
        return {
          o: 'rejected',
          d: { code: body.code ?? 'RISK_REJECTED', message: body.message ?? '' },
          orderId: body.order?.id ?? null,
        };
      }
      if (err instanceof BadRequestException) {
        const body = err.getResponse() as { message?: string };
        return {
          o: 'rejected' as const,
          d: { code: 'INVALID_ORDER', message: String(body.message ?? '') },
        };
      }
      throw err;
    }
  }

  private async enter(
    r: RobotJoinRow,
    baseCcy: string,
    roles: Awaited<ReturnType<UsersRepository['roles']>>,
    actor: Actor,
    s: SignalResult,
  ): Promise<Outcome> {
    if (!s.qty || s.stopDistance === null) return { o: 'refused' as const, d: { code: 'NO_SIZE' } };
    const b = await this.book.book(r, baseCcy);
    const perMinute = await this.book.ordersLastMinute(r);
    if (perMinute >= r.limits.ordersPerMinute)
      return { o: 'refused' as const, d: { code: 'ROBOT_ORDERS_PER_MINUTE', used: perMinute } };
    const q = await this.book.quote(s.symbol);
    if (!q) return { o: 'refused' as const, d: { code: 'NO_MARKET_DATA' } };
    const inst = await this.registry.get(s.symbol);
    const long = s.action === 'enter_long';
    const ref = dec(long ? q.ask : q.bid);
    const tick = inst.spec.tickSize;
    const dist = dec(s.stopDistance.toFixed(12));
    const stop = roundToTick(
      long ? ref.sub(dist) : ref.add(dist),
      tick,
      long ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL,
    );
    const target =
      s.targetDistance === null
        ? null
        : roundToTick(
            long
              ? ref.add(dec(s.targetDistance.toFixed(12)))
              : ref.sub(dec(s.targetDistance.toFixed(12))),
            tick,
            Decimal.ROUND_HALF_UP,
          );
    const rate = (await this.fx.rate(inst.spec.quoteCcy, baseCcy))?.rate ?? new Decimal(1);
    const addNotional = dec(s.qty).mul(ref).mul(inst.multiplier).mul(rate);
    const grossAfter = b.grossExposure.add(addNotional);
    if (b.equity.lte(0) || grossAfter.div(b.equity).gt(dec(String(r.limits.grossExposure))))
      return {
        o: 'refused' as const,
        d: {
          code: 'ROBOT_GROSS_EXPOSURE',
          grossAfter: grossAfter.toFixed(2),
          equity: b.equity.toFixed(2),
        },
      };
    if (stop.lte(0)) return { o: 'refused' as const, d: { code: 'STOP_NOT_POSITIVE' } };
    const req: PlaceOrderRequest = {
      clientOrderId: this.coid('rb', r, s.symbol, s.barTs),
      symbol: s.symbol,
      side: long ? 'buy' : 'sell',
      type: 'market',
      qty: s.qty,
      stopLossPrice: stop.toFixed(inst.spec.pricePrecision),
      ...(target && target.gt(0)
        ? { takeProfitPrice: target.toFixed(inst.spec.pricePrecision) }
        : {}),
      tif: 'ioc',
      reduceOnly: false,
      postOnly: false,
      source: 'manual',
    };
    const res = await this.submit(r, roles, actor, req);
    const d: Record<string, JsonValue> = {
      ...res.d,
      refPrice: ref.toFixed(),
      stopPrice: req.stopLossPrice!,
      targetPrice: req.takeProfitPrice ?? null,
      stopDistance: dist.toFixed(),
      qty: s.qty,
    };
    return { ...res, d };
  }

  private async exit(
    r: RobotJoinRow,
    baseCcy: string,
    roles: Awaited<ReturnType<UsersRepository['roles']>>,
    actor: Actor,
    s: SignalResult,
  ): Promise<Outcome> {
    const b = await this.book.book(r, baseCcy);
    const p = b.positions.find((x) => x.symbol === s.symbol);
    if (!p) return { o: 'none' as const, d: { code: 'NO_POSITION' } };
    const req: PlaceOrderRequest = {
      clientOrderId: this.coid('rx', r, s.symbol, s.barTs),
      symbol: s.symbol,
      side: p.qty.isPositive() ? 'sell' : 'buy',
      type: 'market',
      qty: p.qty.abs().toFixed(),
      tif: 'ioc',
      reduceOnly: true,
      postOnly: false,
      source: 'manual',
    };
    return this.submit(r, roles, actor, req);
  }

  private async trail(
    r: RobotJoinRow,
    roles: Awaited<ReturnType<UsersRepository['roles']>>,
    actor: Actor,
    s: SignalResult,
  ): Promise<Outcome> {
    const stop = await this.workingChild(r, s.symbol, 'stop_loss');
    if (!stop || !s.newStop) return { o: 'none' as const, d: { code: 'NO_STOP_ORDER' } };
    try {
      await this.oms.amend(r.owner_id, roles, stop.id, { stopPrice: s.newStop }, actor);
      return {
        o: 'submitted' as const,
        d: { amended: 'stop', from: stop.stop_price, to: s.newStop },
        orderId: stop.id,
      };
    } catch (err) {
      this.log.warn(`trailing amend refused for robot ${r.id}: ${(err as Error).message}`);
      return {
        o: 'rejected' as const,
        d: { code: 'AMEND_REFUSED', message: (err as Error).message },
      };
    }
  }
}
