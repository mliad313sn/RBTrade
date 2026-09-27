import { BadRequestException, ConflictException } from '@nestjs/common';
import { dec, type OrderSource, type PlaceOrderRequest } from '@kora/domain';

import type { Queryable } from '../db/db.service';

/**
 * IRTC R4-06: binding an order to the AI draft it was placed from.
 *
 * The client no longer chooses `source: 'ai-draft-accepted'`. It sends `aiDraftId` (the ticket
 * prefill) and the server decides:
 * - the draft is the user's, still a draft, not yet bound (or bound to this same client order id,
 *   an idempotent replay), and the order matches it (symbol, side, type, qty) → `ai-draft-accepted`,
 *   and the OMS binds the order to the draft in the order's own transaction if risk accepts it;
 * - otherwise (the user edited the ticket, or the draft was already used) → a `manual` order.
 * `source: 'ai-draft-accepted'` without `aiDraftId` is refused.
 */
export interface DraftSourceDecision {
  source: OrderSource;
  /** Set only when the OMS must bind the new order to this draft. */
  aiDraftId?: string;
}

interface DraftRow {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: string;
  status: string;
  placed_order_id: string | null;
  placed_client_order_id: string | null;
}

export async function decideOrderSource(
  q: Queryable,
  userId: string,
  body: Pick<
    PlaceOrderRequest,
    'source' | 'aiDraftId' | 'symbol' | 'side' | 'type' | 'qty' | 'clientOrderId'
  >,
): Promise<DraftSourceDecision> {
  if (!body.aiDraftId) {
    if (body.source === 'ai-draft-accepted')
      throw new BadRequestException({
        error: 'ai_draft_required',
        message:
          'An order is marked as placed from an AI draft only by the server, from the draft id.',
      });
    return { source: 'manual' };
  }
  const r = await q.query<DraftRow>(
    `SELECT d.id, d.symbol, d.side, d.type, d.qty::text AS qty, d.status, d.placed_order_id,
            o.client_order_id AS placed_client_order_id
       FROM ai_order_drafts d LEFT JOIN orders o ON o.id = d.placed_order_id
      WHERE d.id = $1 AND d.user_id = $2`,
    [body.aiDraftId, userId],
  );
  const d = r.rows[0];
  if (!d)
    throw new BadRequestException({
      error: 'draft_not_found',
      message: 'That AI draft was not found.',
    });
  const matches =
    d.symbol === body.symbol &&
    d.side === body.side &&
    d.type === body.type &&
    dec(d.qty).eq(dec(body.qty));
  if (!matches) return { source: 'manual' };
  // Idempotent replay of the order that bound the draft: same source, nothing to bind again.
  if (d.placed_order_id) {
    return d.placed_client_order_id === body.clientOrderId
      ? { source: 'ai-draft-accepted' }
      : { source: 'manual' };
  }
  if (d.status !== 'draft') return { source: 'manual' };
  return { source: 'ai-draft-accepted', aiDraftId: d.id };
}

/** Called by the OMS inside the order transaction, once risk accepted the order. */
export async function bindDraftToOrder(
  q: Queryable,
  userId: string,
  draftId: string,
  orderId: string,
): Promise<void> {
  const r = await q.query(
    `UPDATE ai_order_drafts SET placed_order_id = $3
      WHERE id = $1 AND user_id = $2 AND status = 'draft' AND placed_order_id IS NULL`,
    [draftId, userId, orderId],
  );
  if (!r.rowCount)
    throw new ConflictException({
      error: 'draft_already_used',
      message: 'This AI draft was already used for another order. Nothing was placed.',
    });
}
