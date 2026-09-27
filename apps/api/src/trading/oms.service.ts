import { createHash } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import {
  availableSize,
  canonicalJson,
  computePreview,
  dec,
  Decimal,
  defaultPreferences,
  evaluateFillExposure,
  evaluateRisk,
  execTypeFor,
  isReducing,
  isNoviceOnly,
  LIMIT_BREACH_CODES,
  notional,
  OPEN_ORDER_STATUSES,
  sessionStatus,
  sideSign,
  zoneOffsetMs,
  type AmendOrderRequest,
  type ExecType,
  type OrderSource,
  type PlaceOrderRequest,
  type PreviewOrderRequest,
  type PreviewResult,
  type Role,
  type RiskViolation,
} from '@kora/domain';

import { OpsMetrics } from '../observability/ops-metrics.service';
import { currentTraceparent, withSpan } from '../observability/spans';
import { AuditService } from '../audit/audit.service';
import { DbService, type Queryable } from '../db/db.service';
import { DisclosureAcknowledgements } from '../disclosures/acknowledgements.service';
import { RISK_WARNING_DISCLOSURE_ID } from '../disclosures/disclosure.types';
import { AccountsService, type Valuation } from './accounts.service';
import { FxService } from './fx.service';
import { MarketViewService, type MarketSnapshot } from './market-view.service';
import { PaperEngineService } from './paper-engine.service';
import { TradingRegistryService, type TradableInstrument } from './trading-registry.service';
import { toOrderDto, type AccountRow, type OrderRow } from './trading.types';
import { TradingTx, type Actor } from './tx';
import { TradingPublisher } from './trading-publisher.service';

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
    private readonly disclosures: DisclosureAcknowledgements,
    @Optional() private readonly metrics?: OpsMetrics,
  ) {
    // IRTC R2-21: the engine re-checks account-level risk before a resting order adds exposure.
    this.engine.setFillGuard((tx, order, inst, qty, price, fxRate) =>
      this.fillExposureViolations(tx, order, inst, qty, price, fxRate),
    );
  }

  /**
   * Account-level risk for a fill that is about to happen on an order approved earlier (resting
   * limit, triggered stop, held market remainder, amended order). Fills that reduce the position
   * always pass; anything that adds exposure must fit margin, leverage, position and loss limits,
   * the Novice borrowing cap and cooling-off, and robots must not be halted.
   */
  async fillExposureViolations(
    tx: TradingTx,
    order: OrderRow,
    inst: TradableInstrument,
    qty: Decimal,
    price: Decimal,
    fxRate: Decimal,
  ): Promise<RiskViolation[]> {
    const posRow = await tx.c.query<{ qty: string }>(
      'SELECT qty::text AS qty FROM positions WHERE account_id = $1 AND symbol = $2',
      [tx.account.id, order.symbol],
    );
    const before = dec(posRow.rows[0]?.qty ?? '0');
    const after = before.add(qty.mul(sideSign(order.side)));
    if (isReducing(before, after)) return [];
    const account = tx.account;
    const valuation = await this.accounts.value(account, tx.c, tx.now);
    const roles = (
      await tx.c.query<{ role: Role }>('SELECT role FROM user_roles WHERE user_id = $1', [
        account.user_id,
      ])
    ).rows.map((r) => r.role);
    const novice = await this.isNovice(account.user_id, roles, tx.c);
    const guard = novice ? await this.accounts.guardState(account, valuation, tx.now, tx.c) : null;
    const pos = valuation.positions.find((p) => p.symbol === order.symbol);
    const posMark = pos?.mark ?? price;
    const marginRate = this.registry.marginRate(inst.spec, account.margin_tier);
    const exposure = (q: Decimal) => notional(q, price, inst.multiplier).mul(fxRate);
    return evaluateFillExposure({
      baseCcy: account.base_currency,
      source: order.source,
      halted: account.trading_halted,
      positionQtyBefore: before,
      positionQtyAfter: after,
      positionNotionalAfter: exposure(after),
      grossExposureAfter: valuation.summary.grossExposure
        .sub(notional(before, posMark, inst.multiplier).mul(pos?.fxRate ?? fxRate))
        .add(exposure(after)),
      equity: valuation.summary.equity,
      marginAfter: valuation.summary.marginUsed
        .add(exposure(after).mul(marginRate))
        .sub(exposure(before).mul(marginRate)),
      dayPnl: valuation.dayPnl,
      weekPnl: valuation.weekPnl,
      monthPnl: valuation.monthPnl,
      limits: this.accounts.limits(account, tx.now),
      novice,
      noviceMaxLeverage: guard ? dec(guard.noviceMaxLeverage) : undefined,
      coolingOff: guard?.coolingOff.reason ?? null,
    });
  }

  /** Guardrails apply to novice-only accounts and to anyone using the Novice view (goal 08). */
  async isNovice(userId: string, roles: Role[], c?: Queryable): Promise<boolean> {
    if (isNoviceOnly(roles)) return true;
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
    opts: { excludeOrderId?: string; skipRegistryChecks?: boolean } = {},
  ): Promise<EvaluatedOrder> {
    const t0 = performance.now();
    const inst = await this.registry.get(req.symbol);
    if (!opts.skipRegistryChecks) this.validateAgainstRegistry(req, inst);
    const now = tx?.now ?? Date.now();
    const snap = await this.market.snapshot(inst, now);
    const valuation = await this.accounts.value(account, tx?.c, now);
    const novice = await this.isNovice(sub.userId, sub.roles, tx?.c);
    // Goal 08: cooling-off and the borrowing cap only matter for guarded accounts.
    const guard = novice ? await this.accounts.guardState(account, valuation, now, tx?.c) : null;
    // Goal 09 (B-801): a novice-only user needs the risk warning in force acknowledged first.
    const disclosureRequired =
      isNoviceOnly(sub.roles) &&
      !(await this.disclosures.isCurrent(sub.userId, RISK_WARNING_DISCLOSURE_ID, tx?.c));
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
    const limit = req.limitPrice ? dec(req.limitPrice) : undefined;
    const marketable =
      !!limit &&
      !!snap.bid &&
      !!snap.ask &&
      (side === 'buy' ? limit.gte(snap.ask) : limit.lte(snap.bid));
    // IRTC R2-03: a resting order is judged on the worst case, i.e. after every other working
    // same-side order on the symbol has filled first (their unfilled remainders). Reduce-only orders
    // are clipped by the engine and never add exposure, so they neither count nor are counted; an
    // order that fills now acts on the actual position (anything resting is re-checked at its fill).
    const immediate =
      execType === 'market' ||
      req.tif === 'ioc' ||
      req.tif === 'fok' ||
      (execType === 'limit' && marketable);
    const pendingSameSide =
      req.reduceOnly || immediate
        ? new Decimal(0)
        : await this.workingSameSide(account.id, req.symbol, side, opts.excludeOrderId, tx?.c);
    const before = posQty.add(pendingSameSide.mul(sideSign(side)));
    const after = before.add(qty.mul(sideSign(side)));
    const posMark = pos?.mark ?? price;
    const grossAfter = valuation.summary.grossExposure
      .sub(notional(posQty, posMark, inst.multiplier).mul(pos?.fxRate ?? fxRate))
      .add(notional(after, price, inst.multiplier).mul(fxRate));
    const marginRate = this.registry.marginRate(inst.spec, account.margin_tier);
    const marginOf = (q: Decimal) => notional(q, price, inst.multiplier).mul(fxRate).mul(marginRate);
    const marginAfter = preview
      ? valuation.summary.marginUsed.add(marginOf(after)).sub(marginOf(posQty))
      : valuation.summary.marginUsed;
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
      fxRateKnown: !!rate,
      mid: snap.mid,
      fatFingerPct: dec(inst.trading.fatFingerPct),
      notionalBase: preview?.exact.notionalBase ?? new Decimal(0),
      positionQtyBefore: before,
      positionQtyAfter: after,
      positionNotionalAfter: notional(after, price, inst.multiplier).mul(fxRate),
      grossExposureAfter: grossAfter,
      equity: valuation.summary.equity,
      marginAfter,
      dayPnl: valuation.dayPnl,
      weekPnl: valuation.weekPnl,
      ordersLastMinute,
      limits: this.accounts.limits(account, now),
      novice,
      noviceMaxLeverage: guard ? dec(guard.noviceMaxLeverage) : undefined,
      coolingOff: guard?.coolingOff.reason ?? null,
      monthPnl: valuation.monthPnl,
      disclosureRequired,
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

  /**
   * Unfilled size of the other working orders on `symbol` on `side` that can add exposure (not
   * reduce-only). OCO legs are alternatives, so a group counts once, at its largest leg.
   */
  private async workingSameSide(
    accountId: string,
    symbol: string,
    side: 'buy' | 'sell',
    excludeOrderId: string | undefined,
    c?: Queryable,
  ): Promise<Decimal> {
    const r = await (c ?? this.db.pool).query<{ oco_group: string | null; rem: string }>(
      `SELECT oco_group, (qty - filled_qty)::text AS rem FROM orders
       WHERE account_id = $1 AND symbol = $2 AND side = $3 AND status = ANY($4) AND exec_type <> 'none'
         AND NOT reduce_only AND ($5::uuid IS NULL OR id <> $5::uuid)`,
      [accountId, symbol, side, OPEN_ORDER_STATUSES, excludeOrderId ?? null],
    );
    const groups = new Map<string, Decimal>();
    let total = new Decimal(0);
    for (const row of r.rows) {
      const rem = dec(row.rem);
      if (!row.oco_group) total = total.add(rem);
      else groups.set(row.oco_group, Decimal.max(groups.get(row.oco_group) ?? new Decimal(0), rem));
    }
    for (const g of groups.values()) total = total.add(g);
    return total;
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
        /** B-202: prices are in this minor unit (e.g. GBX) when set; money stays in quoteCcy. */
        priceUnit: s.priceUnit ?? null,
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
  /** Goal 10: the submit runs in an `oms.submit` span; its trace context is stored on the order. */
  async submit(
    sub: Submitter,
    req: PlaceOrderRequest,
  ): Promise<{
    order: ReturnType<typeof toOrderDto>;
    idempotentReplay: boolean;
    legs?: ReturnType<typeof toOrderDto>[];
  }> {
    const t0 = performance.now();
    const source = sub.source.startsWith('robot:') ? 'robot' : sub.source;
    try {
      const out = await withSpan(
        'oms.submit',
        { 'kora.symbol': req.symbol, 'kora.side': req.side, 'kora.order_type': req.type, 'kora.source': sub.source, 'kora.client_order_id': req.clientOrderId },
        () => this.submitInSpan(sub, req),
      );
      const outcome = out.idempotentReplay ? 'replay' : out.order.status === 'rejected' ? 'rejected' : 'accepted';
      this.metrics?.orderSubmit.observe({ outcome, source }, (performance.now() - t0) / 1000);
      if (outcome === 'rejected') this.metrics?.orderRejections.inc({ code: out.order.rejectCode ?? 'unknown' });
      return out;
    } catch (e) {
      // A pre-trade risk rejection is answered as 422 (the order row is stored as rejected).
      const body = e instanceof UnprocessableEntityException ? (e.getResponse() as { error?: string; code?: string }) : null;
      const outcome = body?.error === 'risk_rejected' ? 'rejected' : 'error';
      this.metrics?.orderSubmit.observe({ outcome, source }, (performance.now() - t0) / 1000);
      if (outcome === 'rejected') this.metrics?.orderRejections.inc({ code: body?.code ?? 'unknown' });
      throw e;
    }
  }

  private async submitInSpan(
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
        // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack -- compares public content hashes, not secrets, reviewed goal 10
        if (o.request_hash !== hash) {
          throw new ConflictException({
            error: 'client_order_id_reused',
            message: 'This client order id was already used for a different order.',
          });
        }
        return { order: o, replay: true, legs: [] as OrderRow[] };
      }
      const ev = await withSpan('risk.evaluate', { 'kora.symbol': req.symbol }, () => this.evaluate(tx.account, req, sub, tx));
      const execType = execTypeFor(req);
      const expireAt =
        req.tif === 'gtd'
          ? new Date(req.expireAt!)
          : req.tif === 'day'
            ? dayExpiry(ev.inst, tx.now)
            : null;
      const ins = await tx.c.query<OrderRow>(
        `INSERT INTO orders (account_id, client_order_id, request_hash, role, symbol, side, type, exec_type, qty, limit_price, stop_price,
           trail_amount, stop_loss_price, take_profit_price, tif, expire_at, reduce_only, post_only, source, status, created_by, trace_parent)
         VALUES ($1, $2, $3, 'primary', $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric,
           $14, $15, $16, $17, $18, 'new', $19, $20)
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
          currentTraceparent(),
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
        // Goal 09: a limit breach reaches the risk officer console (alerts → NOTIFY → risk:alerts).
        const breaches = ev.violations.filter((v) => LIMIT_BREACH_CODES.includes(v.code));
        if (breaches.length)
          await tx.c.query(
            `INSERT INTO alerts (severity, kind, account_id, message, details) VALUES ('warning', 'risk.limit_breach', $1, $2, $3::jsonb)`,
            [
              account.id,
              `Pre-trade limit hit: ${breaches.map((b) => b.code).join(', ')} (${req.side} ${req.qty} ${req.symbol}).`,
              JSON.stringify({
                orderId: order.id,
                symbol: req.symbol,
                side: req.side,
                qty: req.qty,
                source: sub.source,
                codes: breaches.map((b) => b.code),
                message: breaches[0]!.message,
              }),
            ],
          );
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
               tif, expire_at, reduce_only, source, status, created_by, trace_parent)
             VALUES ($1, $2, $2, 'oco_leg', $3, $4, 'oco', $5, $6::numeric, $7::numeric, $8::numeric, $9, $10, $11, $12, 'new', $13, $14) RETURNING *`,
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
              order.trace_parent ?? null,
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
      // IRTC R2-26: while the kill switch holds the account, robots cannot act, amends included.
      if (tx.account.trading_halted && actor.type === 'robot')
        throw riskRejection([
          {
            code: 'TRADING_HALTED',
            message:
              'Trading is halted by the kill switch. Robot orders are blocked until someone authorised resumes trading.',
          },
        ]);
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
      // IRTC R2-11: a new trailing distance applies at once from the best price seen so far.
      if (fields.trail_amount && order.trail_ref_price && !order.triggered_at) {
        const ref = dec(order.trail_ref_price);
        const trail = dec(fields.trail_amount);
        fields.stop_price = (order.side === 'sell' ? ref.sub(trail) : ref.add(trail)).toFixed();
      }
      const snap = await this.market.snapshot(inst, tx.now);
      if (snap.mid) {
        const band = dec(inst.trading.fatFingerPct);
        for (const col of ['limit_price', 'stop_price'] as const) {
          const v = fields[col];
          if (col === 'stop_price' && fields.trail_amount) continue; // derived, not typed
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
      // IRTC R2-04: in the simple view a trade always keeps its full protective stop; it can be
      // tightened, never widened, shrunk or removed while the position is open.
      if (order.role === 'stop_loss' && (await this.isNovice(userId, roles, tx.c))) {
        const widened =
          fields.stop_price !== undefined &&
          (order.side === 'sell'
            ? dec(fields.stop_price).lt(dec(order.stop_price!))
            : dec(fields.stop_price).gt(dec(order.stop_price!)));
        if (widened || fields.qty !== undefined)
          throw riskRejection([
            {
              code: 'NOVICE_STOP_REQUIRED',
              message: widened
                ? 'In the simple view a stop loss can be moved closer to the price, not further away, so the loss stays capped.'
                : 'In the simple view the stop loss always covers the whole trade.',
            },
          ]);
      }
      // IRTC R2-02: a post-only order must still not take liquidity after an amend.
      const newLimit = fields.limit_price ? dec(fields.limit_price) : null;
      if (
        order.post_only &&
        newLimit &&
        snap.bid &&
        snap.ask &&
        (order.side === 'buy' ? newLimit.gte(snap.ask) : newLimit.lte(snap.bid))
      )
        throw riskRejection([
          {
            code: 'POST_ONLY_WOULD_TAKE',
            message: 'A post-only order must not trade immediately; this price would cross the spread.',
          },
        ]);
      // IRTC R2-01: an amend is a new approval of the order. Anything but a pure size reduction runs
      // the pre-trade risk check again on the amended order (its unfilled remainder).
      const qtyUp = fields.qty !== undefined && dec(fields.qty).gt(dec(order.qty));
      const priceChanged = ['limit_price', 'stop_price', 'trail_amount'].some((c) => c in fields);
      if (qtyUp || priceChanged) {
        const violations = await this.amendViolations(tx, order, fields, { userId, roles, actor });
        if (violations.length) throw riskRejection(violations);
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
      // A price the order now reaches is taken like a new order would take it (IRTC R2-02).
      this.engine.forget(order.id);
      const worked = await this.engine.work(tx, updated, snap, inst, false);
      return toOrderDto(worked);
    });
  }

  /** Pre-trade risk for an amended order, restricted to the rules an amend can breach. */
  private async amendViolations(
    tx: TradingTx,
    order: OrderRow,
    fields: Record<string, string>,
    who: { userId: string; roles: Role[]; actor: Actor },
  ): Promise<RiskViolation[]> {
    const qty = dec(fields.qty ?? order.qty).sub(dec(order.filled_qty));
    const execType = order.exec_type as Exclude<ExecType, 'none'>;
    const req = {
      symbol: order.symbol,
      side: order.side,
      type: execType,
      qty: qty.toFixed(),
      limitPrice: fields.limit_price ?? order.limit_price ?? undefined,
      stopPrice: execType === 'trailing' ? undefined : (fields.stop_price ?? order.stop_price ?? undefined),
      trailAmount: fields.trail_amount ?? order.trail_amount ?? undefined,
      tif: order.tif === 'gtd' || order.tif === 'day' ? 'gtc' : order.tif,
      reduceOnly: order.reduce_only,
      postOnly: order.post_only,
      source: 'manual',
    } as unknown as PreviewOrderRequest;
    const source = who.actor.type === 'robot' ? order.source : 'manual';
    const ev = await this.evaluate(tx.account, req, { userId: who.userId, roles: who.roles, source: source as OrderSource }, tx, {
      excludeOrderId: order.id,
      skipRegistryChecks: true,
    });
    return ev.violations.filter((v) => !AMEND_EXEMPT_CODES.has(v.code));
  }

  async cancel(
    userId: string,
    orderId: string,
    reason = 'user_requested',
    actor: Actor = { type: 'user', id: userId },
    roles?: Role[],
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
      if (roles && (await this.protectsGuardedPosition(tx, order, userId, roles)))
        throw riskRejection([
          {
            code: 'NOVICE_STOP_REQUIRED',
            message:
              'In the simple view an open trade keeps its stop loss. Close the trade to remove it, or move the stop closer to the price.',
          },
        ]);
      const row = await this.engine.cancel(tx, order, reason, actor);
      return toOrderDto(row);
    });
  }

  /**
   * Cancels every open order of the user's account, optionally for one symbol (Pro terminal
   * "Cancel all", goal 04). Each order goes through the engine's normal cancel path, so OCO groups,
   * bracket children and the audit trail behave exactly as for a single cancel.
   */
  async cancelAll(userId: string, symbol?: string, roles?: Role[]) {
    const account = await this.accounts.ensure(userId);
    return this.withAccount(account.id, async (tx) => {
      const guarded = roles ? await this.isNovice(userId, roles, tx.c) : false;
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
        // IRTC R2-04: "Cancel all" never strips the stop loss of an open guarded (Novice) trade.
        if (guarded && (await this.isProtectiveStopOfOpenPosition(tx, row))) continue;
        cancelled.push(
          toOrderDto(
            await this.engine.cancel(tx, row, 'user_cancel_all', { type: 'user', id: userId }),
          ),
        );
      }
      return { accountId: tx.account.id, cancelled: cancelled.length, orders: cancelled };
    });
  }

  /** A stop-loss child whose position is still open (the stop sits opposite to the position). */
  private async isProtectiveStopOfOpenPosition(tx: TradingTx, order: OrderRow): Promise<boolean> {
    if (order.role !== 'stop_loss') return false;
    const r = await tx.c.query<{ qty: string }>(
      'SELECT qty::text AS qty FROM positions WHERE account_id = $1 AND symbol = $2',
      [tx.account.id, order.symbol],
    );
    const pos = dec(r.rows[0]?.qty ?? '0');
    return pos.mul(sideSign(order.side)).isNegative();
  }

  /** IRTC R2-04: guarded users cannot remove the stop loss of an open trade. */
  private async protectsGuardedPosition(
    tx: TradingTx,
    order: OrderRow,
    userId: string,
    roles: Role[],
  ): Promise<boolean> {
    if (!(await this.isProtectiveStopOfOpenPosition(tx, order))) return false;
    return this.isNovice(userId, roles, tx.c);
  }

  private async lockOrder(tx: TradingTx, orderId: string): Promise<OrderRow> {
    const r = await tx.c.query<OrderRow>(
      'SELECT * FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE',
      [orderId, tx.account.id],
    );
    if (!r.rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Order not found' });
    return r.rows[0];
  }

  /**
   * Cancels every open order of the account in one statement (kill switch scope 2+). With
   * `keepProtective`, the stop-loss / take-profit children of open positions stay working.
   */
  async cancelAllOpen(
    tx: TradingTx,
    reason: string,
    actor: Actor,
    extra: Record<string, string>,
    opts: { keepProtective?: boolean } = {},
  ): Promise<OrderRow[]> {
    const r = await tx.c.query<OrderRow & { prev_status: OrderRow['status'] }>(
      `WITH open AS (SELECT id, status FROM orders WHERE account_id = $1 AND status = ANY($2)
         AND NOT ($4 AND role IN ('stop_loss', 'take_profit')) FOR UPDATE)
       UPDATE orders o SET status = 'cancelled', cancel_reason = $3, updated_at = clock_timestamp()
       FROM open WHERE o.id = open.id RETURNING o.*, open.status AS prev_status`,
      [tx.account.id, OPEN_ORDER_STATUSES, reason, opts.keepProtective ?? false],
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

/**
 * Rules that do not apply when an existing order is amended: they concern how an order is entered
 * (rate, novice order type and entry stop, fill-now market checks, entry brackets) or are enforced
 * by the engine at fill time (reduce-only clipping, held orders on unsafe markets).
 */
const AMEND_EXEMPT_CODES: ReadonlySet<RiskViolation['code']> = new Set([
  'ORDER_RATE_LIMIT',
  'NOVICE_ORDER_TYPE',
  'NOVICE_STOP_REQUIRED',
  'SESSION_CLOSED',
  'NO_MARKET_DATA',
  'MARKET_DATA_STALE',
  'FEED_NOT_OK',
  'FOK_INSUFFICIENT_DEPTH',
  'STOP_LOSS_WRONG_SIDE',
  'TAKE_PROFIT_WRONG_SIDE',
  'REDUCE_ONLY_WOULD_INCREASE',
]);

function riskRejection(violations: RiskViolation[]): RiskRejection {
  return new RiskRejection({
    statusCode: 422,
    error: 'risk_rejected',
    code: violations[0]!.code,
    message: violations[0]!.message,
    violations,
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function stripExact(p: PreviewResult) {
  const { exact: _exact, estimatedPriceExact: _e, ...rest } = p;
  return rest;
}

/**
 * The trading day of 24-hour venues (FX, index CFDs) ends at the 17:00 New York roll, the market
 * convention for the FX value date (IRTC R2-19).
 */
export const DAY_ROLL_TIMEZONE = 'America/New_York';
export const DAY_ROLL_MINUTES = 17 * 60;
const DAY_MS = 86_400_000;

/** The next 17:00 New York roll strictly after `now`. */
export function nextDayRoll(now: number): number {
  for (let d = -1; d <= 2; d++) {
    const local = now + zoneOffsetMs(now, DAY_ROLL_TIMEZONE);
    const dayStart = Math.floor(local / DAY_MS) * DAY_MS + d * DAY_MS;
    const guess = dayStart + DAY_ROLL_MINUTES * 60_000;
    const utc = guess - zoneOffsetMs(guess - zoneOffsetMs(guess, DAY_ROLL_TIMEZONE), DAY_ROLL_TIMEZONE);
    if (utc > now) return utc;
  }
  return now + DAY_MS;
}

/**
 * DAY orders end with the venue's trading day: the next close for exchange venues, the 17:00 New
 * York roll (or the daily break) for venues that trade around the clock on weekdays, and local
 * midnight for 24/7 venues.
 */
export function dayExpiry(inst: TradableInstrument, now: number): Date {
  const cal = inst.spec.tradingSessions ?? inst.venue.calendar;
  const tz = inst.spec.tradingSessions?.timezone ?? inst.venue.timezone;
  let t = now;
  let breakAt: number | null = null;
  for (let i = 0; i < 8; i++) {
    const s = sessionStatus(cal, tz, t);
    if (!s.nextChange) break;
    const next = Date.parse(s.nextChange);
    if (s.state === 'open' && s.nextState === 'break' && breakAt === null) breakAt = next;
    if (s.state === 'open' && (s.nextState === 'closed' || s.nextState === 'holiday')) {
      // A session that runs for more than a day (FX Sunday–Friday, CFDs with a daily break) is not
      // one trading day: the day ends at the daily break or the 17:00 New York roll.
      if (next - now <= DAY_MS) return new Date(next);
      const roll = nextDayRoll(now);
      const end = breakAt !== null && breakAt - now <= DAY_MS ? Math.min(breakAt, roll) : roll;
      return new Date(Math.min(end, next));
    }
    t = next + 1;
  }
  // Daily breaks every day and no weekly close in sight: the day ends at the break or the roll.
  if (breakAt !== null && breakAt - now <= DAY_MS) return new Date(Math.min(breakAt, nextDayRoll(now)));
  const s = sessionStatus(cal, tz, now);
  const [y, m, d] = s.localDate.split('-').map(Number) as [number, number, number];
  const localMidnightUtc = Date.UTC(y, m - 1, d + 1);
  // UTC minus venue-local wall time (minute resolution), applied to the next local midnight.
  const offset =
    Math.round((now - Date.parse(`${s.localDate}T${s.localTime}:00Z`)) / 60_000) * 60_000;
  return new Date(localMidnightUtc + offset);
}
