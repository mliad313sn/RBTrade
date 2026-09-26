import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  availableSize,
  canonicalJson,
  computePreview,
  dec,
  Decimal,
  defaultPreferences,
  evaluateRisk,
  execTypeFor,
  hasAnyRole,
  notional,
  OPEN_ORDER_STATUSES,
  sessionStatus,
  sideSign,
  type AmendOrderRequest,
  type ExecType,
  type OrderSource,
  type PlaceOrderRequest,
  type PreviewOrderRequest,
  type PreviewResult,
  type Role,
  type RiskViolation,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';
import { AccountsService, type Valuation } from './accounts.service';
import { FxService } from './fx.service';
import { MarketViewService, type MarketSnapshot } from './market-view.service';
import { PaperEngineService } from './paper-engine.service';
import { TradingRegistryService, type TradableInstrument } from './trading-registry.service';
import { toOrderDto, type AccountRow, type OrderRow } from './trading.types';
import { TradingTx, type Actor } from './tx';
import { TradingPublisher } from './trading-publisher.service';

const PRO_ROLES: readonly Role[] = ['trader', 'quant', 'risk_officer', 'admin'];

export interface Submitter {
  userId: string;
  roles: Role[];
  actor: Actor;
  source: OrderSource;
}

export interface EvaluatedOrder {
  inst: TradableInstrument;
  snap: MarketSnapshot;
  preview: PreviewResult | null;
  violations: RiskViolation[];
  valuation: Valuation;
  novice: boolean;
  timings: { riskMs: number; totalMs: number };
}

export class RiskRejection extends UnprocessableEntityException {}

type AnyOrderRequest = PlaceOrderRequest | PreviewOrderRequest;

function onGrid(value: string, step: string): boolean {
  return dec(value).mod(dec(step)).isZero();
}

/**
 * Order management (goal 03): validation against the registry, idempotency on
 * (account, client_order_id), pre-trade risk, state machine, then the paper engine for anything
 * that fills on arrival. Manual, AI-draft and robot orders all go through `submit`.
 */
@Injectable()
export class OmsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly registry: TradingRegistryService,
    private readonly market: MarketViewService,
    private readonly fx: FxService,
    private readonly engine: PaperEngineService,
    private readonly publisher: TradingPublisher,
  ) {}

  /** Guardrails apply to novice-only accounts and to anyone using the Novice view (goal 08). */
  async isNovice(userId: string, roles: Role[], c?: Queryable): Promise<boolean> {
    if (!hasAnyRole(roles, PRO_ROLES)) return true;
    // Inside a trading transaction, reuse its connection: never take a second pool connection
    // while holding the account lock (pool exhaustion under parallel submits).
    const r = await (c ?? this.db.pool).query<{ view_mode: string }>(
      'SELECT view_mode FROM user_preferences WHERE user_id = $1',
      [userId],
    );
    return (r.rows[0]?.view_mode ?? defaultPreferences(roles).viewMode) === 'novice';
  }

  /** Registry grid checks: qty on the step and at least min qty, prices on the tick. */
  validateAgainstRegistry(req: AnyOrderRequest, inst: TradableInstrument): void {
    const s = inst.spec;
    const issues: Array<{ path: string; message: string }> = [];
    if (!onGrid(req.qty, s.qtyStep) || dec(req.qty).lt(dec(s.minQty))) {
      issues.push({
        path: 'qty',
        message: `Quantity must be a multiple of ${s.qtyStep} and at least ${s.minQty}.`,
      });
    }
    const prices: Array<[string, string | undefined]> = [
      ['limitPrice', req.limitPrice],
      ['stopPrice', req.stopPrice],
      ['stopLossPrice', req.stopLossPrice],
      ['takeProfitPrice', req.takeProfitPrice],
      ['trailAmount', req.trailAmount],
      ...(req.legs ?? []).flatMap(
        (l, i): Array<[string, string | undefined]> => [
          [`legs.${i}.limitPrice`, l.limitPrice],
          [`legs.${i}.stopPrice`, l.stopPrice],
        ],
      ),
    ];
    for (const [path, v] of prices)
      if (v !== undefined && !onGrid(v, s.tickSize))
        issues.push({ path, message: `Prices move in steps of ${s.tickSize}.` });
    if (req.tif === 'gtd' && req.expireAt && Date.parse(req.expireAt) <= Date.now())
      issues.push({ path: 'expireAt', message: 'The expiry time must be in the future.' });
    if (issues.length)
      throw new BadRequestException({
        statusCode: 400,
        error: 'invalid_order',
        message: issues[0]!.message,
        issues,
      });
  }

  /** Builds preview + risk verdict for a request (no persistence). */
  async evaluate(
    account: AccountRow,
    req: AnyOrderRequest,
    sub: Pick<Submitter, 'userId' | 'roles' | 'source'>,
    tx?: TradingTx,
  ): Promise<EvaluatedOrder> {
    const t0 = performance.now();
    const inst = await this.registry.get(req.symbol);
    this.validateAgainstRegistry(req, inst);
    const now = tx?.now ?? Date.now();
    const snap = await this.market.snapshot(inst, now);
    const valuation = await this.accounts.value(account, tx?.c, now);
    const novice = await this.isNovice(sub.userId, sub.roles, tx?.c);
    const rate = await this.fx.rate(inst.spec.quoteCcy, account.base_currency, now);
    const pos = valuation.positions.find((p) => p.symbol === req.symbol);
    const posQty = pos?.qty ?? new Decimal(0);
    const execType = execTypeFor(req);
    const side = req.side;
    const qty = dec(req.qty);
    const ordersLastMinute = Number(
      (
        await (tx?.c ?? this.db.pool).query<{ n: string }>(
          `SELECT count(*)::text AS n FROM orders WHERE account_id = $1 AND role = 'primary' AND parent_order_id IS NULL AND created_at > clock_timestamp() - interval '1 minute'`,
          [account.id],
        )
      ).rows[0]!.n,
    );

    let preview: PreviewResult | null = null;
    const legPrices = (req.legs ?? [])
      .flatMap((l) => [l.limitPrice, l.stopPrice])
      .filter((x): x is string => !!x);
    if (snap.bid && snap.ask && rate) {
      const previewExec: Exclude<ExecType, 'none'> =
        execType === 'none' ? (req.legs?.[0]?.type ?? 'limit') : execType;
      const leg0 = req.legs?.[0];
      preview = computePreview({
        side,
        qty,
        execType: previewExec,
        limitPrice:
          (req.limitPrice ?? leg0?.limitPrice)
            ? dec((req.limitPrice ?? leg0?.limitPrice)!)
            : undefined,
        stopPrice:
          (req.stopPrice ?? leg0?.stopPrice) ? dec((req.stopPrice ?? leg0?.stopPrice)!) : undefined,
        trailAmount: req.trailAmount ? dec(req.trailAmount) : undefined,
        stopLossPrice: req.stopLossPrice ? dec(req.stopLossPrice) : undefined,
        takeProfitPrice: req.takeProfitPrice ? dec(req.takeProfitPrice) : undefined,
        quote: { bid: snap.bid, ask: snap.ask },
        depth: snap.depth ? { bids: snap.depth.bids, asks: snap.depth.asks } : null,
        walk: {
          tickSize: inst.spec.tickSize,
          impactTicks: inst.trading.impactTicks,
          volFactor: inst.trading.volFactor,
          maxLevels: inst.trading.maxLevels,
          lastMidMove: snap.lastMidMove,
        },
        pricePrecision: inst.spec.pricePrecision,
        multiplier: inst.multiplier,
        quoteCcy: inst.spec.quoteCcy,
        baseCcy: account.base_currency,
        fees: inst.fees,
        marginRate: this.registry.marginRate(inst.spec, account.margin_tier),
        fxRate: rate.rate,
        equity: valuation.summary.equity,
        marginUsed: valuation.summary.marginUsed,
        positionQty: posQty,
        confirm: novice
          ? { ...this.accounts.confirmSettings(account), mode: 'always' }
          : this.accounts.confirmSettings(account),
      });
    }

    const tRisk = performance.now();
    const price = preview?.estimatedPriceExact ?? snap.mid ?? new Decimal(0);
    const fxRate = rate?.rate ?? new Decimal(1);
    const after = posQty.add(qty.mul(sideSign(side)));
    const posMark = pos?.mark ?? price;
    const grossAfter = valuation.summary.grossExposure
      .sub(notional(posQty, posMark, inst.multiplier).mul(pos?.fxRate ?? fxRate))
      .add(notional(after, price, inst.multiplier).mul(fxRate));
    const limit = req.limitPrice ? dec(req.limitPrice) : undefined;
    const marketable =
      !!limit &&
      !!snap.bid &&
      !!snap.ask &&
      (side === 'buy' ? limit.gte(snap.ask) : limit.lte(snap.bid));
    const book = snap.depth
      ? side === 'buy'
        ? snap.depth.asks
        : snap.depth.bids
      : snap.quote
        ? [
            [
              side === 'buy' ? snap.quote.ask : snap.quote.bid,
              side === 'buy' ? snap.quote.askSize : snap.quote.bidSize,
            ] as [string, string],
          ]
        : [];
    const violations = evaluateRisk({
      order: {
        type: req.type,
        execType,
        tif: req.tif,
        reduceOnly: req.reduceOnly,
        postOnly: req.postOnly,
        source: sub.source,
        prices: [
          req.limitPrice,
          req.stopPrice,
          req.stopLossPrice,
          req.takeProfitPrice,
          ...legPrices,
        ]
          .filter((x): x is string => !!x)
          .map((x) => dec(x)),
        hasStopLoss: !!req.stopLossPrice,
        marketable: execType === 'limit' && marketable,
      },
      baseCcy: account.base_currency,
      instrumentStatus: inst.spec.status,
      session: snap.session,
      marketData: snap.safety,
      fxAvailable: !!rate && rate.fresh,
      mid: snap.mid,
      fatFingerPct: dec(inst.trading.fatFingerPct),
      notionalBase: preview?.exact.notionalBase ?? new Decimal(0),
      positionQtyBefore: posQty,
      positionQtyAfter: after,
      positionNotionalAfter: notional(after, price, inst.multiplier).mul(fxRate),
      grossExposureAfter: grossAfter,
      equity: valuation.summary.equity,
      marginAfter: preview?.exact.marginAfter ?? valuation.summary.marginUsed,
      dayPnl: valuation.dayPnl,
      weekPnl: valuation.weekPnl,
      ordersLastMinute,
      limits: this.accounts.limits(account),
      novice,
      halted: account.trading_halted,
      previewIssues: preview?.issues ?? [],
      availableNow:
        req.tif === 'fok' ? availableSize(side, book, inst.trading.maxLevels, limit) : null,
      qty,
    });
    const t1 = performance.now();
    return {
      inst,
      snap,
      preview,
      violations,
      valuation,
      novice,
      timings: { riskMs: t1 - tRisk, totalMs: t1 - t0 },
    };
  }

  async preview(userId: string, roles: Role[], req: PreviewOrderRequest) {
    const account = await this.accounts.ensure(userId);
    const ev = await this.evaluate(account, req, { userId, roles, source: req.source });
    const s = ev.inst.spec;
    return {
      symbol: s.symbol,
      simulated: true,
      environment: 'PAPER' as const,
      instrument: {
        assetClass: s.assetClass,
        quoteCcy: s.quoteCcy,
        pricePrecision: s.pricePrecision,
        tickSize: s.tickSize,
        qtyStep: s.qtyStep,
        minQty: s.minQty,
        multiplier: ev.inst.multiplier.toFixed(),
        feeScheduleId: s.feeScheduleId,
        feesSimulated: ev.inst.fees.simulated,
      },
      market: {
        bid: ev.snap.quote?.bid ?? null,
        ask: ev.snap.quote?.ask ?? null,
        session: ev.snap.session,
        dataState: ev.snap.safety,
        dataReason: ev.snap.safetyReason,
      },
      novice: ev.novice,
      preview: ev.preview ? stripExact(ev.preview) : null,
      risk: { ok: ev.violations.length === 0, violations: ev.violations },
      timings: { riskMs: round3(ev.timings.riskMs), totalMs: round3(ev.timings.totalMs) },
    };
  }

  private requestHash(req: PlaceOrderRequest, source: string): string {
    return createHash('sha256')
      .update(canonicalJson({ ...JSON.parse(JSON.stringify(req)), source }))
      .digest('hex');
  }

  /**
   * Places an order. Returns `{order, idempotentReplay}`; a risk rejection is persisted (so the
   * same client order id replays the same answer) and thrown as HTTP 422.
   */
  async submit(
    sub: Submitter,
    req: PlaceOrderRequest,
  ): Promise<{
    order: ReturnType<typeof toOrderDto>;
    idempotentReplay: boolean;
    legs?: ReturnType<typeof toOrderDto>[];
  }> {
    const account = await this.accounts.ensure(sub.userId);
    const hash = this.requestHash(req, sub.source);
    const inst = await this.registry.get(req.symbol);
    this.validateAgainstRegistry(req, inst);
    // Fast path for replays: no lock needed to read a committed order.
    const known = await this.db.query<OrderRow>(
      'SELECT * FROM orders WHERE account_id = $1 AND client_order_id = $2',
      [account.id, req.clientOrderId],
    );
    if (known[0] && known[0].request_hash === hash && known[0].status !== 'rejected') {
      return { order: toOrderDto(known[0]), idempotentReplay: true };
    }
    const out = await this.withAccount(account.id, async (tx) => {
      const existing = await tx.c.query<OrderRow>(
        'SELECT * FROM orders WHERE account_id = $1 AND client_order_id = $2',
        [account.id, req.clientOrderId],
      );
      if (existing.rows[0]) {
        const o = existing.rows[0];
        if (o.request_hash !== hash) {
          throw new ConflictException({
            error: 'client_order_id_reused',
            message: 'This client order id was already used for a different order.',
          });
        }
        return { order: o, replay: true, legs: [] as OrderRow[] };
      }
      const ev = await this.evaluate(tx.account, req, sub, tx);
      const execType = execTypeFor(req);
      const expireAt =
        req.tif === 'gtd'
          ? new Date(req.expireAt!)
          : req.tif === 'day'
            ? dayExpiry(ev.inst, tx.now)
            : null;
      const ins = await tx.c.query<OrderRow>(
        `INSERT INTO orders (account_id, client_order_id, request_hash, role, symbol, side, type, exec_type, qty, limit_price, stop_price,
           trail_amount, stop_loss_price, take_profit_price, tif, expire_at, reduce_only, post_only, source, status, created_by)
         VALUES ($1, $2, $3, 'primary', $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric,
           $14, $15, $16, $17, $18, 'new', $19)
         ON CONFLICT (account_id, client_order_id) DO NOTHING RETURNING *`,
        [
          account.id,
          req.clientOrderId,
          hash,
          req.symbol,
          req.side,
          req.type,
          execType,
          req.qty,
          req.limitPrice ?? null,
          req.stopPrice ?? null,
          req.trailAmount ?? null,
          req.stopLossPrice ?? null,
          req.takeProfitPrice ?? null,
          req.tif,
          expireAt,
          req.reduceOnly,
          req.postOnly,
          sub.source,
          sub.userId,
        ],
      );
      let order = ins.rows[0]!;
      tx.changes.order(order);
      tx.audit(sub.actor, 'order.new', 'order', order.id, {
        accountId: account.id,
        clientOrderId: req.clientOrderId,
        symbol: req.symbol,
        side: req.side,
        type: req.type,
        qty: req.qty,
        limitPrice: req.limitPrice ?? null,
        stopPrice: req.stopPrice ?? null,
        stopLossPrice: req.stopLossPrice ?? null,
        takeProfitPrice: req.takeProfitPrice ?? null,
        tif: req.tif,
        source: sub.source,
        novice: ev.novice,
        riskMs: String(round3(ev.timings.riskMs)),
        environment: 'PAPER',
      });
      if (ev.violations.length) {
        const first = ev.violations[0]!;
        order = await this.engine.transition(
          tx,
          order,
          'rejected',
          sub.actor,
          { reject_code: first.code, reject_message: first.message },
          {
            code: first.code,
            codes: ev.violations.map((v) => v.code).join(','),
            message: first.message,
          },
        );
        return { order, replay: false, legs: [] as OrderRow[], violations: ev.violations };
      }
      order = await this.engine.transition(
        tx,
        order,
        'accepted',
        sub.actor,
        {},
        { riskChecks: 'passed' },
      );
      order = await this.engine.transition(tx, order, 'working', ENGINE(), {});
      const legs: OrderRow[] = [];
      if (req.type === 'oco') {
        for (const leg of req.legs!) {
          const r = await tx.c.query<OrderRow>(
            `INSERT INTO orders (account_id, parent_order_id, oco_group, role, symbol, side, type, exec_type, qty, limit_price, stop_price,
               tif, expire_at, reduce_only, source, status, created_by)
             VALUES ($1, $2, $2, 'oco_leg', $3, $4, 'oco', $5, $6::numeric, $7::numeric, $8::numeric, $9, $10, $11, $12, 'new', $13) RETURNING *`,
            [
              account.id,
              order.id,
              req.symbol,
              req.side,
              leg.type,
              req.qty,
              leg.limitPrice ?? null,
              leg.stopPrice ?? null,
              req.tif,
              expireAt,
              req.reduceOnly,
              sub.source,
              sub.userId,
            ],
          );
          let l = r.rows[0]!;
          tx.changes.order(l);
          tx.audit(sub.actor, 'order.new', 'order', l.id, {
            accountId: account.id,
            parentOrderId: order.id,
            symbol: req.symbol,
            role: 'oco_leg',
            legType: leg.type,
            qty: req.qty,
            environment: 'PAPER',
          });
          l = await this.engine.transition(
            tx,
            l,
            'accepted',
            sub.actor,
            {},
            { parentOrderId: order.id },
          );
          l = await this.engine.transition(
            tx,
            l,
            'working',
            ENGINE(),
            {},
            { parentOrderId: order.id },
          );
          legs.push(l);
        }
        for (let i = 0; i < legs.length; i++) {
          const fresh = await tx.c.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [
            legs[i]!.id,
          ]);
          legs[i] = await this.engine.work(tx, fresh.rows[0]!, ev.snap, ev.inst, true);
        }
        const box = await tx.c.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [order.id]);
        order = box.rows[0]!;
      } else {
        order = await this.engine.work(tx, order, ev.snap, ev.inst, true);
      }
      return { order, replay: false, legs };
    });
    if ('violations' in out && out.violations) {
      throw new RiskRejection({
        statusCode: 422,
        error: 'risk_rejected',
        code: out.violations[0]!.code,
        message: out.violations[0]!.message,
        violations: out.violations,
        order: toOrderDto(out.order),
      });
    }
    if (out.replay && out.order.status === 'rejected') {
      throw new RiskRejection({
        statusCode: 422,
        error: 'risk_rejected',
        code: out.order.reject_code,
        message: out.order.reject_message,
        violations: [{ code: out.order.reject_code, message: out.order.reject_message }],
        order: toOrderDto(out.order),
        idempotentReplay: true,
      });
    }
    return {
      order: toOrderDto(out.order),
      idempotentReplay: out.replay,
      ...(out.legs.length ? { legs: out.legs.map(toOrderDto) } : {}),
    };
  }

  /** Runs `fn` in a READ COMMITTED transaction holding the account lock; audits and publishes. */
  async withAccount<T>(
    accountId: string,
    fn: (tx: TradingTx) => Promise<T>,
    now = Date.now(),
  ): Promise<T> {
    let changes: TradingTx['changes'] | null = null;
    const result = await this.db.tx(async (c) => {
      const account = await this.accounts.lock(c, accountId);
      const tx = new TradingTx(c, account, now);
      const r = await fn(tx);
      await this.audit.recordMany(tx.audits, c);
      changes = tx.changes;
      return r;
    });
    if (changes) this.publisher.publish(changes);
    return result;
  }

  async amend(
    userId: string,
    roles: Role[],
    orderId: string,
    patch: AmendOrderRequest,
    actor: Actor = { type: 'user', id: userId },
  ) {
    const account = await this.accounts.ensure(userId);
    return this.withAccount(account.id, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (!['working', 'partially_filled'].includes(order.status)) {
        throw new ConflictException({
          error: 'not_amendable',
          message: `A ${order.status.replace('_', ' ')} order cannot be amended.`,
        });
      }
      if (order.exec_type === 'none')
        throw new ConflictException({
          error: 'not_amendable',
          message: 'Amend the OCO legs, not the group.',
        });
      const inst = await this.registry.get(order.symbol);
      const fields: Record<string, string> = {};
      if (patch.qty) {
        if (!onGrid(patch.qty, inst.spec.qtyStep) || dec(patch.qty).lt(dec(inst.spec.minQty)))
          throw new BadRequestException({
            error: 'invalid_order',
            message: `Quantity must be a multiple of ${inst.spec.qtyStep} and at least ${inst.spec.minQty}.`,
          });
        if (dec(patch.qty).lte(dec(order.filled_qty)))
          throw new ConflictException({
            error: 'not_amendable',
            message: 'The new quantity must be above what has already filled.',
          });
        fields.qty = patch.qty;
      }
      for (const [k, col, has] of [
        ['limitPrice', 'limit_price', ['limit', 'stop_limit']],
        ['stopPrice', 'stop_price', ['stop', 'stop_limit']],
        ['trailAmount', 'trail_amount', ['trailing']],
      ] as const) {
        const v = patch[k];
        if (v === undefined) continue;
        if (!(has as readonly string[]).includes(order.exec_type))
          throw new BadRequestException({
            error: 'invalid_order',
            message: `This ${order.exec_type} order has no ${k}.`,
          });
        if (!onGrid(v, inst.spec.tickSize))
          throw new BadRequestException({
            error: 'invalid_order',
            message: `Prices move in steps of ${inst.spec.tickSize}.`,
          });
        fields[col] = v;
      }
      const snap = await this.market.snapshot(inst, tx.now);
      if (snap.mid) {
        const band = dec(inst.trading.fatFingerPct);
        for (const col of ['limit_price', 'stop_price'] as const) {
          const v = fields[col];
          if (v && dec(v).sub(snap.mid).abs().div(snap.mid).mul(100).gt(band)) {
            throw new RiskRejection({
              statusCode: 422,
              error: 'risk_rejected',
              code: 'FAT_FINGER',
              message: `The price ${v} is more than ${band.toFixed()}% away from the market (${snap.mid.toFixed()}). Check for a typo.`,
            });
          }
        }
      }
      const updated = await this.engine.patch(tx, order, fields);
      tx.audit(actor, 'order.amended', 'order', order.id, {
        accountId: account.id,
        changed: JSON.parse(JSON.stringify(patch)) as Record<string, string>,
        previous: {
          qty: order.qty,
          limitPrice: order.limit_price,
          stopPrice: order.stop_price,
          trailAmount: order.trail_amount,
        },
      });
      void roles;
      const worked = await this.engine.work(tx, updated, snap, inst, false);
      return toOrderDto(worked);
    });
  }

  async cancel(
    userId: string,
    orderId: string,
    reason = 'user_requested',
    actor: Actor = { type: 'user', id: userId },
  ) {
    const account = await this.accounts.ensure(userId);
    return this.withAccount(account.id, async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      if (!OPEN_ORDER_STATUSES.includes(order.status)) {
        throw new ConflictException({
          error: 'not_cancellable',
          message: `The order is already ${order.status.replace('_', ' ')}.`,
        });
      }
      const row = await this.engine.cancel(tx, order, reason, actor);
      return toOrderDto(row);
    });
  }

  /**
   * Cancels every open order of the user's account, optionally for one symbol (Pro terminal
   * "Cancel all", goal 04). Each order goes through the engine's normal cancel path, so OCO groups,
   * bracket children and the audit trail behave exactly as for a single cancel.
   */
  async cancelAll(userId: string, symbol?: string) {
    const account = await this.accounts.ensure(userId);
    return this.withAccount(account.id, async (tx) => {
      const params: unknown[] = [tx.account.id, OPEN_ORDER_STATUSES];
      if (symbol) params.push(symbol);
      const r = await tx.c.query<OrderRow>(
        `SELECT * FROM orders WHERE account_id = $1 AND status = ANY($2) ${symbol ? 'AND symbol = $3' : ''}
         ORDER BY (exec_type = 'none') DESC, created_at FOR UPDATE`,
        params,
      );
      const cancelled: ReturnType<typeof toOrderDto>[] = [];
      for (const o of r.rows) {
        const cur = await tx.c.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [o.id]);
        const row = cur.rows[0];
        if (!row || !OPEN_ORDER_STATUSES.includes(row.status)) continue;
        cancelled.push(toOrderDto(await this.engine.cancel(tx, row, 'user_cancel_all', { type: 'user', id: userId })));
      }
      return { accountId: tx.account.id, cancelled: cancelled.length, orders: cancelled };
    });
  }

  private async lockOrder(tx: TradingTx, orderId: string): Promise<OrderRow> {
    const r = await tx.c.query<OrderRow>(
      'SELECT * FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE',
      [orderId, tx.account.id],
    );
    if (!r.rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Order not found' });
    return r.rows[0];
  }

  /** Cancels every open order of the account in one statement (kill switch scope 2+). */
  async cancelAllOpen(
    tx: TradingTx,
    reason: string,
    actor: Actor,
    extra: Record<string, string>,
  ): Promise<OrderRow[]> {
    const r = await tx.c.query<OrderRow & { prev_status: OrderRow['status'] }>(
      `WITH open AS (SELECT id, status FROM orders WHERE account_id = $1 AND status = ANY($2) FOR UPDATE)
       UPDATE orders o SET status = 'cancelled', cancel_reason = $3, updated_at = clock_timestamp()
       FROM open WHERE o.id = open.id RETURNING o.*, open.status AS prev_status`,
      [tx.account.id, OPEN_ORDER_STATUSES, reason],
    );
    for (const row of r.rows) {
      this.engine.forget(row.id);
      tx.changes.order(row);
      tx.audit(actor, 'order.cancelled', 'order', row.id, {
        accountId: row.account_id,
        symbol: row.symbol,
        side: row.side,
        type: row.type,
        role: row.role,
        qty: row.qty,
        filledQty: row.filled_qty,
        from: row.prev_status,
        reason,
        environment: 'PAPER',
        ...extra,
      });
    }
    return r.rows;
  }

  // ---- reads -------------------------------------------------------------------------------------

  async list(
    userId: string,
    q: { status?: 'open' | 'all'; symbol?: string; limit?: number; before?: string },
  ) {
    const account = await this.accounts.ensure(userId);
    const params: unknown[] = [account.id];
    const where = ['account_id = $1'];
    if (q.status !== 'all') {
      params.push(OPEN_ORDER_STATUSES);
      where.push(`status = ANY($${params.length})`);
    }
    if (q.symbol) {
      params.push(q.symbol);
      where.push(`symbol = $${params.length}`);
    }
    if (q.before) {
      params.push(q.before);
      where.push(`created_at < $${params.length}::timestamptz`);
    }
    params.push(Math.min(Math.max(q.limit ?? 100, 1), 2000));
    const rows = await this.db.query<OrderRow>(
      `SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id LIMIT $${params.length}`,
      params,
    );
    return { accountId: account.id, orders: rows.map(toOrderDto) };
  }

  async get(userId: string, orderId: string) {
    const account = await this.accounts.ensure(userId);
    const rows = await this.db.query<OrderRow>(
      'SELECT * FROM orders WHERE id = $1 AND account_id = $2',
      [orderId, account.id],
    );
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Order not found' });
    const children = await this.db.query<OrderRow>(
      'SELECT * FROM orders WHERE parent_order_id = $1 ORDER BY created_at',
      [orderId],
    );
    return { ...toOrderDto(rows[0]), children: children.map(toOrderDto) };
  }
}

const ENGINE = (): Actor => ({ type: 'system', id: 'paper-engine' });

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function stripExact(p: PreviewResult) {
  const { exact: _exact, estimatedPriceExact: _e, ...rest } = p;
  return rest;
}

/** DAY orders end with the venue's trading day: the next close, or local midnight for 24/7 venues. */
export function dayExpiry(inst: TradableInstrument, now: number): Date {
  const cal = inst.spec.tradingSessions ?? inst.venue.calendar;
  const tz = inst.spec.tradingSessions?.timezone ?? inst.venue.timezone;
  let t = now;
  for (let i = 0; i < 8; i++) {
    const s = sessionStatus(cal, tz, t);
    if (!s.nextChange) break;
    const next = Date.parse(s.nextChange);
    if (s.state === 'open' && (s.nextState === 'closed' || s.nextState === 'holiday'))
      return new Date(next);
    t = next + 1;
  }
  const s = sessionStatus(cal, tz, now);
  const [y, m, d] = s.localDate.split('-').map(Number) as [number, number, number];
  const localMidnightUtc = Date.UTC(y, m - 1, d + 1);
  // UTC minus venue-local wall time (minute resolution), applied to the next local midnight.
  const offset =
    Math.round((now - Date.parse(`${s.localDate}T${s.localTime}:00Z`)) / 60_000) * 60_000;
  return new Date(localMidnightUtc + offset);
}
