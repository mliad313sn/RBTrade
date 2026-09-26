import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  applyFill,
  assertTransition,
  availableSize,
  commission,
  convert,
  dec,
  Decimal,
  fillJournal,
  oppositeSide,
  sideSign,
  spreadCost,
  statusAfterFill,
  swapAmount,
  swapJournal,
  walkBook,
  type DepthLevel,
  type OrderStatus,
} from '@kora/domain';

import { FxService } from './fx.service';
import { LedgerService } from './ledger.service';
import { MarketViewService, type MarketSnapshot } from './market-view.service';
import { TradingRegistryService, type TradableInstrument } from './trading-registry.service';
import type { FillRow, OrderRow, PositionRow } from './trading.types';
import { ENGINE_ACTOR, type Actor, type TradingTx } from './tx';

const OPEN: readonly OrderStatus[] = ['new', 'accepted', 'working', 'partially_filled'];
const WORKABLE: readonly OrderStatus[] = ['working', 'partially_filled'];
const PATCHABLE = new Set([
  'qty',
  'filled_qty',
  'avg_fill_price',
  'limit_price',
  'stop_price',
  'trail_amount',
  'trail_ref_price',
  'triggered_at',
  'reject_code',
  'reject_message',
  'cancel_reason',
  'expire_at',
]);

export interface FillPiece {
  qty: Decimal;
  price: Decimal;
}

/**
 * The paper execution engine (goal 03 §3). Works one order at a time inside an account-locked
 * transaction: trigger checks (stops on the correct side of the book, trailing reference), depth
 * walk with the registry slippage model, partial fills, fees, FX conversion, ledger postings,
 * positions, bracket/OCO sibling handling and reduce-only hygiene. Every state change is audited.
 */
@Injectable()
export class PaperEngineService {
  private readonly log = new Logger('PaperEngine');
  /** Depth sequence last consumed by a taker order, so one snapshot's liquidity is used once. */
  private readonly consumedSeq = new Map<string, number>();

  constructor(
    private readonly registry: TradingRegistryService,
    private readonly market: MarketViewService,
    private readonly fx: FxService,
    private readonly ledger: LedgerService,
  ) {}

  // ---- order row helpers ---------------------------------------------------------------------

  async patch(
    tx: TradingTx,
    order: OrderRow,
    fields: Record<string, string | Date | null>,
  ): Promise<OrderRow> {
    const keys = Object.keys(fields);
    for (const k of keys) if (!PATCHABLE.has(k)) throw new Error(`not patchable: ${k}`);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const r = await tx.c.query<OrderRow>(
      `UPDATE orders SET ${sets.join(', ')}${sets.length ? ', ' : ''}updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
      [order.id, ...keys.map((k) => fields[k])],
    );
    const row = r.rows[0]!;
    tx.changes.order(row);
    return row;
  }

  async transition(
    tx: TradingTx,
    order: OrderRow,
    to: OrderStatus,
    actor: Actor,
    fields: Record<string, string | Date | null> = {},
    payload: Record<string, string | number | boolean | null> = {},
  ): Promise<OrderRow> {
    assertTransition(order.status, to);
    const keys = Object.keys(fields);
    for (const k of keys) if (!PATCHABLE.has(k)) throw new Error(`not patchable: ${k}`);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`);
    const r = await tx.c.query<OrderRow>(
      `UPDATE orders SET status = $2${sets.length ? ', ' : ''}${sets.join(', ')}, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
      [order.id, to, ...keys.map((k) => fields[k])],
    );
    const row = r.rows[0]!;
    tx.changes.order(row);
    tx.audit(actor, `order.${to}`, 'order', row.id, {
      accountId: row.account_id,
      symbol: row.symbol,
      side: row.side,
      type: row.type,
      role: row.role,
      qty: row.qty,
      filledQty: row.filled_qty,
      from: order.status,
      source: row.source,
      environment: 'PAPER',
      ...payload,
    });
    return row;
  }

  async cancel(
    tx: TradingTx,
    order: OrderRow,
    reason: string,
    actor: Actor,
    extra: Record<string, string> = {},
  ): Promise<OrderRow> {
    if (!OPEN.includes(order.status)) return order;
    const row = await this.transition(
      tx,
      order,
      'cancelled',
      actor,
      { cancel_reason: reason },
      { reason, ...extra },
    );
    this.consumedSeq.delete(order.id);
    if (row.exec_type === 'none') {
      // OCO container: cancel open legs.
      const legs = await tx.c.query<OrderRow>(
        `SELECT * FROM orders WHERE parent_order_id = $1 AND status = ANY($2) FOR UPDATE`,
        [row.id, OPEN],
      );
      for (const leg of legs.rows) await this.cancel(tx, leg, reason, actor, extra);
    } else if (row.role === 'oco_leg' && row.parent_order_id) {
      await this.settleOcoContainer(tx, row.parent_order_id, actor);
    }
    return row;
  }

  async expire(tx: TradingTx, order: OrderRow, reason: string): Promise<OrderRow> {
    if (!OPEN.includes(order.status) || order.status === 'new') return order;
    const row = await this.transition(
      tx,
      order,
      'expired',
      ENGINE_ACTOR,
      { cancel_reason: reason },
      { reason },
    );
    this.consumedSeq.delete(order.id);
    if (row.role === 'oco_leg' && row.parent_order_id)
      await this.settleOcoContainer(tx, row.parent_order_id, ENGINE_ACTOR);
    return row;
  }

  // ---- working an order -------------------------------------------------------------------------

  /**
   * Evaluates one open order against a market snapshot and fills what the market allows.
   * `arrival` = the order is being placed now (taker semantics, IOC/FOK apply).
   */
  async work(
    tx: TradingTx,
    input: OrderRow,
    snap: MarketSnapshot,
    inst: TradableInstrument,
    arrival: boolean,
  ): Promise<OrderRow> {
    let order = input;
    if (!WORKABLE.includes(order.status) || order.exec_type === 'none') return order;
    // Fill safety (goal 02): hold resting orders; never fill on stale, unhealthy or closed markets.
    if (snap.safety !== 'ok' || snap.session !== 'open' || !snap.bid || !snap.ask || !snap.quote)
      return order;
    const rate = await this.fx.rate(inst.spec.quoteCcy, tx.account.base_currency, tx.now);
    if (!rate || !rate.fresh) return order;

    const side = order.side;
    const bid = snap.bid;
    const ask = snap.ask;
    let remaining = dec(order.qty).sub(dec(order.filled_qty));
    if (remaining.lte(0)) return order;

    // Reduce-only: never increase or flip the position.
    if (order.reduce_only) {
      const pos = await this.position(tx, order.symbol);
      const posQty = dec(pos?.qty ?? '0');
      const closable = posQty.mul(sideSign(side)).isNegative() ? posQty.abs() : new Decimal(0);
      if (closable.isZero()) return this.cancel(tx, order, 'position_closed', ENGINE_ACTOR);
      if (closable.lt(remaining)) remaining = closable;
    }

    // Trailing stops follow the best price since placement.
    if (order.exec_type === 'trailing' && !order.triggered_at) {
      const trail = dec(order.trail_amount!);
      const prevRef = order.trail_ref_price ? dec(order.trail_ref_price) : null;
      const ref =
        side === 'sell'
          ? prevRef && prevRef.gt(bid)
            ? prevRef
            : bid
          : prevRef && prevRef.lt(ask)
            ? prevRef
            : ask;
      if (!prevRef || !ref.eq(prevRef)) {
        const stop = side === 'sell' ? ref.sub(trail) : ref.add(trail);
        order = await this.patch(tx, order, {
          trail_ref_price: ref.toFixed(),
          stop_price: stop.toFixed(),
        });
      }
    }

    let justTriggered = false;
    if (
      (order.exec_type === 'stop' ||
        order.exec_type === 'stop_limit' ||
        order.exec_type === 'trailing') &&
      !order.triggered_at
    ) {
      const stop = dec(order.stop_price!);
      // Buy stops trigger on the ask, sell stops on the bid.
      const hit = side === 'buy' ? ask.gte(stop) : bid.lte(stop);
      if (!hit) return order;
      order = await this.patch(tx, order, { triggered_at: new Date(tx.now) });
      tx.audit(ENGINE_ACTOR, 'order.triggered', 'order', order.id, {
        accountId: order.account_id,
        symbol: order.symbol,
        stopPrice: order.stop_price!,
        bid: bid.toFixed(),
        ask: ask.toFixed(),
        quoteSeq: snap.quote.seq,
      });
      justTriggered = true;
    }

    const book: readonly DepthLevel[] = snap.depth
      ? side === 'buy'
        ? snap.depth.asks
        : snap.depth.bids
      : [
          [
            (side === 'buy' ? ask : bid).toFixed(),
            (side === 'buy' ? snap.quote.askSize : snap.quote.bidSize) || remaining.toFixed(),
          ],
        ];
    const walkParams = {
      tickSize: inst.spec.tickSize,
      impactTicks: inst.trading.impactTicks,
      volFactor: inst.trading.volFactor,
      maxLevels: inst.trading.maxLevels,
      lastMidMove: snap.lastMidMove,
    };
    const touch = side === 'buy' ? ask : bid;
    const bookSeq = snap.depth?.seq ?? snap.quote.seq;

    let pieces: FillPiece[] = [];
    let reference: Decimal;
    let liquidity: 'taker' | 'maker' = 'taker';
    const isStopMarket = order.exec_type === 'stop' || order.exec_type === 'trailing';
    if (order.exec_type === 'market' || isStopMarket) {
      reference = isStopMarket ? dec(order.stop_price!) : touch;
      if (!arrival && !justTriggered && this.consumedSeq.get(order.id) === bookSeq) return order;
      if (
        arrival &&
        order.tif === 'fok' &&
        availableSize(side, book, walkParams.maxLevels).lt(remaining)
      )
        return this.expire(tx, order, 'fok_unfillable');
      pieces = walkBook(side, book, remaining, walkParams).fills;
    } else {
      // limit or triggered stop-limit
      const limit = dec(order.limit_price!);
      reference = limit;
      const marketable = side === 'buy' ? ask.lte(limit) : bid.gte(limit);
      if (!marketable) {
        if (arrival && (order.tif === 'ioc' || order.tif === 'fok'))
          return this.expire(tx, order, order.tif === 'fok' ? 'fok_unfillable' : 'ioc_remainder');
        return order;
      }
      if (
        arrival &&
        order.tif === 'fok' &&
        availableSize(side, book, walkParams.maxLevels, limit).lt(remaining)
      )
        return this.expire(tx, order, 'fok_unfillable');
      if (arrival || justTriggered) {
        pieces = walkBook(side, book, remaining, walkParams, limit).fills;
      } else {
        // A resting limit that the market has reached fills at its limit (maker), up to visible size.
        if (this.consumedSeq.get(order.id) === bookSeq) return order;
        liquidity = 'maker';
        const size = availableSize(side, book, walkParams.maxLevels, limit);
        const q = Decimal.min(size, remaining);
        pieces = q.gt(0) ? [{ qty: q, price: limit }] : [];
      }
    }
    this.consumedSeq.set(order.id, bookSeq);

    for (const piece of pieces) {
      order = await this.bookFill(tx, order, inst, snap, piece, reference, liquidity, rate.rate);
    }
    if (arrival && order.tif === 'ioc' && WORKABLE.includes(order.status))
      order = await this.expire(tx, order, 'ioc_remainder');
    if (pieces.length) await this.afterFill(tx, order, snap, inst);
    return order;
  }

  // ---- booking ----------------------------------------------------------------------------------

  private async position(tx: TradingTx, symbol: string): Promise<PositionRow | null> {
    const r = await tx.c.query<PositionRow>(
      'SELECT * FROM positions WHERE account_id = $1 AND symbol = $2 FOR UPDATE',
      [tx.account.id, symbol],
    );
    return r.rows[0] ?? null;
  }

  private async bookFill(
    tx: TradingTx,
    order: OrderRow,
    inst: TradableInstrument,
    snap: MarketSnapshot,
    piece: FillPiece,
    reference: Decimal,
    liquidity: 'taker' | 'maker',
    rate: Decimal,
  ): Promise<OrderRow> {
    const base = tx.account.base_currency;
    const same = inst.spec.quoteCcy === base;
    const pos = await this.position(tx, order.symbol);
    const before = { qty: dec(pos?.qty ?? '0'), avgPrice: dec(pos?.avg_price ?? '0') };
    const applied = applyFill(
      before,
      { side: order.side, qty: piece.qty, price: piece.price },
      inst.multiplier,
    );
    const commQuote = commission(
      inst.fees,
      piece.qty,
      piece.price,
      inst.multiplier,
      inst.spec.quoteCcy,
    );
    const realizedBase = applied.realizedPnl.mul(rate);
    const commBase = commQuote.mul(rate);
    const conv = same
      ? new Decimal(0)
      : convert(commQuote.add(applied.realizedPnl.abs()), rate, inst.fees.fxConversionBps, false)
          .cost;
    const spread = spreadCost(piece.qty, snap.bid!, snap.ask!, inst.multiplier).mul(rate);
    const slippage = piece.price.sub(reference).mul(sideSign(order.side));
    const q = snap.quote!;
    const quoteAtDecision = {
      bid: q.bid,
      ask: q.ask,
      seq: q.seq,
      source: q.source,
      exchangeTs: q.exchangeTs,
      receivedTs: q.receivedTs,
    };

    const fill = await tx.c.query<FillRow>(
      `INSERT INTO fills (order_id, account_id, symbol, side, qty, price, quote_at_decision, reference_price, slippage, commission,
         spread_cost, fx_rate, fx_conversion_cost, realized_pnl, liquidity)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::jsonb, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15)
       RETURNING *`,
      [
        order.id,
        tx.account.id,
        order.symbol,
        order.side,
        piece.qty.toFixed(),
        piece.price.toFixed(),
        JSON.stringify(quoteAtDecision),
        reference.toFixed(),
        slippage.toFixed(),
        commBase.toDecimalPlaces(10).toFixed(),
        spread.toDecimalPlaces(10).toFixed(),
        rate.toFixed(),
        conv.toDecimalPlaces(10).toFixed(),
        realizedBase.toDecimalPlaces(10).toFixed(),
        liquidity,
      ],
    );
    const fillRow = fill.rows[0]!;
    await this.ledger.post(
      tx.c,
      tx.account.id,
      fillJournal({
        realizedPnl: realizedBase,
        commission: commBase,
        fxConversionCost: conv,
        currency: base,
      }),
      {
        type: 'fill',
        id: fillRow.id,
      },
    );
    await tx.c.query(
      `INSERT INTO positions (account_id, symbol, qty, avg_price, realized_pnl, opened_at, updated_at)
       VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, CASE WHEN $3::numeric <> 0 THEN clock_timestamp() END, clock_timestamp())
       ON CONFLICT (account_id, symbol) DO UPDATE SET qty = EXCLUDED.qty, avg_price = EXCLUDED.avg_price,
         realized_pnl = positions.realized_pnl + EXCLUDED.realized_pnl,
         opened_at = CASE WHEN EXCLUDED.qty = 0 THEN NULL WHEN positions.qty = 0 OR sign(positions.qty) <> sign(EXCLUDED.qty) THEN clock_timestamp() ELSE positions.opened_at END,
         updated_at = clock_timestamp()`,
      [
        tx.account.id,
        order.symbol,
        applied.position.qty.toFixed(),
        applied.position.avgPrice.toFixed(),
        realizedBase.toDecimalPlaces(10).toFixed(),
      ],
    );
    tx.changes.position(tx.account.id);

    const filled = dec(order.filled_qty).add(piece.qty);
    const avg = order.avg_fill_price
      ? dec(order.avg_fill_price)
          .mul(dec(order.filled_qty))
          .add(piece.qty.mul(piece.price))
          .div(filled)
      : piece.price;
    const to = statusAfterFill(filled, dec(order.qty));
    return this.transition(
      tx,
      order,
      to,
      ENGINE_ACTOR,
      { filled_qty: filled.toFixed(), avg_fill_price: avg.toFixed() },
      {
        fillId: fillRow.id,
        fillQty: piece.qty.toFixed(),
        fillPrice: piece.price.toFixed(),
        referencePrice: reference.toFixed(),
        slippage: slippage.toFixed(),
        commission: commBase.toDecimalPlaces(10).toFixed(),
        fxConversionCost: conv.toDecimalPlaces(10).toFixed(),
        realizedPnl: realizedBase.toDecimalPlaces(10).toFixed(),
        fxRate: rate.toFixed(),
        currency: base,
        liquidity,
        quoteBid: q.bid,
        quoteAsk: q.ask,
        quoteSeq: q.seq,
        quoteSource: q.source,
      },
    );
  }

  /** Brackets, OCO siblings and reduce-only hygiene after an order received fills. */
  private async afterFill(
    tx: TradingTx,
    order: OrderRow,
    snap: MarketSnapshot,
    inst: TradableInstrument,
  ): Promise<void> {
    // Attached stop loss / take profit: create on the first fill, then track the filled size.
    if (order.role === 'primary' && (order.stop_loss_price || order.take_profit_price)) {
      const kids = await tx.c.query<OrderRow>(
        `SELECT * FROM orders WHERE parent_order_id = $1 AND role IN ('stop_loss','take_profit') FOR UPDATE`,
        [order.id],
      );
      if (kids.rows.length === 0) {
        const group = randomUUID();
        const created: OrderRow[] = [];
        if (order.stop_loss_price)
          created.push(await this.createChild(tx, order, 'stop_loss', group));
        if (order.take_profit_price)
          created.push(await this.createChild(tx, order, 'take_profit', group));
        for (const child of created) await this.work(tx, child, snap, inst, false);
      } else {
        for (const k of kids.rows) {
          if (WORKABLE.includes(k.status) && !dec(k.qty).eq(dec(order.filled_qty))) {
            await this.patch(tx, k, { qty: order.filled_qty });
          }
        }
      }
    }

    // One-cancels-other: a filled leg cancels its siblings; a partial fill shrinks them.
    if (order.oco_group) {
      const sibs = await tx.c.query<OrderRow>(
        `SELECT * FROM orders WHERE oco_group = $1 AND id <> $2 AND exec_type <> 'none' AND status = ANY($3) FOR UPDATE`,
        [order.oco_group, order.id, WORKABLE],
      );
      const left = dec(order.qty).sub(dec(order.filled_qty));
      for (const s of sibs.rows) {
        if (order.status === 'filled')
          await this.cancel(tx, s, 'oco_sibling_filled', ENGINE_ACTOR, { siblingId: order.id });
        else if (dec(s.qty).sub(dec(s.filled_qty)).gt(left))
          await this.patch(tx, s, { qty: dec(s.filled_qty).add(left).toFixed() });
      }
      if (order.role === 'oco_leg' && order.parent_order_id)
        await this.settleOcoContainer(tx, order.parent_order_id, ENGINE_ACTOR);
    }

    await this.syncReduceOnly(tx, order.symbol);
  }

  private async createChild(
    tx: TradingTx,
    parent: OrderRow,
    role: 'stop_loss' | 'take_profit',
    group: string,
  ): Promise<OrderRow> {
    const stop = role === 'stop_loss';
    const r = await tx.c.query<OrderRow>(
      `INSERT INTO orders (account_id, parent_order_id, oco_group, role, symbol, side, type, exec_type, qty, limit_price, stop_price,
         tif, reduce_only, source, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8::numeric, $9::numeric, $10::numeric, 'gtc', true, $11, 'new', $12) RETURNING *`,
      [
        tx.account.id,
        parent.id,
        group,
        role,
        parent.symbol,
        oppositeSide(parent.side),
        stop ? 'stop' : 'limit',
        parent.filled_qty,
        stop ? null : parent.take_profit_price,
        stop ? parent.stop_loss_price : null,
        parent.source,
        parent.created_by,
      ],
    );
    let child = r.rows[0]!;
    tx.changes.order(child);
    tx.audit(ENGINE_ACTOR, 'order.new', 'order', child.id, {
      accountId: child.account_id,
      symbol: child.symbol,
      role,
      parentOrderId: parent.id,
      qty: child.qty,
      environment: 'PAPER',
    });
    child = await this.transition(
      tx,
      child,
      'accepted',
      ENGINE_ACTOR,
      {},
      { parentOrderId: parent.id },
    );
    return this.transition(tx, child, 'working', ENGINE_ACTOR, {}, { parentOrderId: parent.id });
  }

  /** OCO container mirrors its legs: filled when a leg fills, cancelled when no leg is left. */
  private async settleOcoContainer(
    tx: TradingTx,
    containerId: string,
    actor: Actor,
  ): Promise<void> {
    const r = await tx.c.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [
      containerId,
    ]);
    const box = r.rows[0];
    if (!box || !OPEN.includes(box.status)) return;
    const legs = await tx.c.query<OrderRow>('SELECT * FROM orders WHERE parent_order_id = $1', [
      containerId,
    ]);
    const filledLeg = legs.rows.find((l) => dec(l.filled_qty).gt(0));
    if (filledLeg) {
      const to = filledLeg.status === 'filled' ? 'filled' : 'partially_filled';
      if (box.status !== to || box.filled_qty !== filledLeg.filled_qty) {
        await this.transition(
          tx,
          box,
          to,
          actor,
          { filled_qty: filledLeg.filled_qty, avg_fill_price: filledLeg.avg_fill_price },
          { legId: filledLeg.id },
        );
      }
      return;
    }
    if (legs.rows.every((l) => !OPEN.includes(l.status)))
      await this.transition(tx, box, 'cancelled', actor, { cancel_reason: 'all_legs_closed' }, {});
  }

  /** Reduce-only orders never outsize the position; they are cancelled when it is flat or flips. */
  async syncReduceOnly(tx: TradingTx, symbol: string): Promise<void> {
    const pos = await this.position(tx, symbol);
    const posQty = dec(pos?.qty ?? '0');
    const orders = await tx.c.query<OrderRow>(
      `SELECT * FROM orders WHERE account_id = $1 AND symbol = $2 AND reduce_only AND status = ANY($3) ORDER BY created_at FOR UPDATE`,
      [tx.account.id, symbol, OPEN],
    );
    for (const o of orders.rows) {
      const closable = posQty.mul(sideSign(o.side)).isNegative() ? posQty.abs() : new Decimal(0);
      if (closable.isZero()) {
        await this.cancel(tx, o, 'position_closed', ENGINE_ACTOR);
        continue;
      }
      const rem = dec(o.qty).sub(dec(o.filled_qty));
      if (rem.gt(closable))
        await this.patch(tx, o, { qty: dec(o.filled_qty).add(closable).toFixed() });
    }
  }

  // ---- daily roll -------------------------------------------------------------------------------

  /** Charges overnight funding on every open position once per account per roll date. */
  async rollAccount(tx: TradingTx, rollDate: string): Promise<number> {
    const done = await tx.c.query(
      'INSERT INTO account_rolls (account_id, roll_date) VALUES ($1, $2::date) ON CONFLICT DO NOTHING RETURNING 1',
      [tx.account.id, rollDate],
    );
    if (!done.rowCount) return 0;
    const positions = await tx.c.query<PositionRow>(
      'SELECT * FROM positions WHERE account_id = $1 AND qty <> 0',
      [tx.account.id],
    );
    let charged = 0;
    for (const p of positions.rows) {
      const inst = await this.registry.get(p.symbol);
      const snap = await this.market.snapshot(inst, tx.now);
      if (!snap.mid) continue;
      const rate = await this.fx.rate(inst.spec.quoteCcy, tx.account.base_currency, tx.now);
      if (!rate) continue;
      const quoteAmt = swapAmount(inst.fees, dec(p.qty), snap.mid, inst.multiplier, 1);
      if (quoteAmt.isZero()) continue;
      const same = inst.spec.quoteCcy === tx.account.base_currency;
      const conv = convert(quoteAmt, rate.rate, inst.fees.fxConversionBps, same);
      const amount = conv.base.sub(conv.cost);
      await this.ledger.post(tx.c, tx.account.id, swapJournal(amount, tx.account.base_currency), {
        type: 'swap',
        id: `${p.symbol}:${rollDate}`,
      });
      tx.audit(ENGINE_ACTOR, 'position.swap_booked', 'position', `${tx.account.id}:${p.symbol}`, {
        accountId: tx.account.id,
        symbol: p.symbol,
        rollDate,
        qty: p.qty,
        mark: snap.mid.toFixed(),
        amount: amount.toDecimalPlaces(10).toFixed(),
        currency: tx.account.base_currency,
      });
      charged += 1;
    }
    if (charged) tx.changes.position(tx.account.id);
    return charged;
  }

  forget(orderId: string): void {
    this.consumedSeq.delete(orderId);
  }

  get logger(): Logger {
    return this.log;
  }
}
