import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  dec,
  PreviewOrderSchema,
  roundQtyDown,
  type Role,
  type StrategyDefinition,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { TradingRegistryService } from '../trading/trading-registry.service';
import { sha256 } from './core/hash';
import type { ToolCallCtx, ToolInput } from './core/tools';
import { neutralise } from './core/untrusted';
import { AiReadPorts } from './read-ports';

/** Pre-trade risk codes that mean "too big to place" (IRTC R4-15). */
const DRAFT_SIZE_CODES = [
  'MAX_ORDER_NOTIONAL',
  'FAT_FINGER',
  'MAX_POSITION',
  'MAX_LEVERAGE',
  'INSUFFICIENT_MARGIN',
];

/**
 * Drafts are the copilot's only "write": an order draft pre-fills the goal 04 ticket (the user still
 * previews and confirms; the order then carries `source: 'ai-draft-accepted'`), and a strategy draft
 * is a validated candidate definition (only a human saves a version). Neither can execute anything.
 */
@Injectable()
export class DraftsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly registry: TradingRegistryService,
    private readonly ports: AiReadPorts,
  ) {}

  async createOrderDraft(ctx: ToolCallCtx, input: ToolInput<'create_order_draft'>) {
    const inst = await this.registry.get(input.symbol);
    const s = inst.spec;
    if (s.status !== 'active')
      throw new BadRequestException({
        error: 'not_tradable',
        message: `${s.symbol} is ${s.status}.`,
      });
    const qty = input.qty ? dec(input.qty) : dec(s.minQty);
    const onGrid = roundQtyDown(qty, s.qtyStep);
    if (!onGrid.eq(qty) || qty.lt(dec(s.minQty))) {
      throw new BadRequestException({
        error: 'invalid_qty',
        message: `Quantity must be a multiple of ${s.qtyStep} and at least ${s.minQty}.`,
      });
    }
    if (input.type === 'limit' && !input.limitPrice)
      throw new BadRequestException({
        error: 'invalid_draft',
        message: 'A limit draft needs a limit price.',
      });

    // Read-only preview so the draft shows its cost; a failing preview does not block the draft
    // (the ticket re-previews before anything can be placed).
    let preview: Record<string, unknown> = {};
    try {
      const req = PreviewOrderSchema.parse({
        symbol: s.symbol,
        side: input.side,
        type: input.type,
        qty: qty.toFixed(),
        ...(input.limitPrice ? { limitPrice: input.limitPrice } : {}),
        ...(input.stopLossPrice ? { stopLossPrice: input.stopLossPrice } : {}),
        ...(input.takeProfitPrice ? { takeProfitPrice: input.takeProfitPrice } : {}),
      });
      const pv = await this.ports.previewOrder(ctx.user.id, ctx.user.roles, req);
      preview = {
        estimatedPrice: pv.preview?.estimatedPrice ?? null,
        currency: pv.preview?.currency ?? null,
        feesTotal: pv.preview?.fees.total ?? null,
        marginRequired: pv.preview?.margin.required ?? null,
        lossIfStopHit: pv.preview?.lossIfStopHit?.total ?? null,
        riskOk: pv.risk.ok,
        violations: pv.risk.violations.map((v: { code: string }) => v.code).join(','),
      };
    } catch (err) {
      preview = {
        error: String(
          (err as { response?: { message?: string }; message?: string }).response?.message ??
            (err as Error).message,
        ).slice(0, 200),
      };
    }

    // IRTC R4-15: a draft the risk preview says cannot be placed for its size (notional, fat finger,
    // position, leverage, margin) is not created: the model cannot park an oversized order in a ticket.
    const sizeCodes = String(preview.violations ?? '')
      .split(',')
      .filter((c) => DRAFT_SIZE_CODES.includes(c));
    if (sizeCodes.length)
      throw new BadRequestException({
        error: 'draft_too_large',
        message: `The draft is refused: the order preview rejects it for size (${sizeCodes.join(', ')}). Ask for a smaller size.`,
      });

    const id = await this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO ai_order_drafts (user_id, surface, symbol, side, type, qty, limit_price, stop_loss_price, take_profit_price, rationale, preview, model_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          ctx.user.id,
          ctx.surface,
          s.symbol,
          input.side,
          input.type,
          qty.toFixed(),
          input.limitPrice ?? null,
          input.stopLossPrice ?? null,
          input.takeProfitPrice ?? null,
          input.rationale,
          JSON.stringify(preview),
          ctx.modelId,
        ],
      );
      const draftId = r.rows[0]!.id;
      await this.audit.record(
        {
          actorId: ctx.user.id,
          actorType: 'ai',
          action: 'ai.draft',
          entity: 'ai_order_draft',
          entityId: draftId,
          payload: {
            kind: 'order',
            surface: ctx.surface,
            modelId: ctx.modelId,
            promptHash: ctx.promptHash,
            symbol: s.symbol,
            side: input.side,
            type: input.type,
            qty: qty.toFixed(),
            environment: 'PAPER',
            canSubmit: false,
            // IRTC R4-08: the model-written rationale shown in the ticket is provable.
            rationaleHash: sha256(input.rationale),
          },
        },
        c,
      );
      return draftId;
    });
    // IRTC R4-15: the rationale is model text; the ticket note says so and it is neutralised.
    const note = `AI draft ${id.slice(0, 8)} · copilot's words, not advice: ${neutralise(input.rationale).slice(0, 80)}`;
    return {
      draftId: id,
      status: 'draft',
      prefill: {
        symbol: s.symbol,
        side: input.side,
        type: input.type,
        qty: qty.toFixed(),
        ...(input.limitPrice ? { limitPrice: input.limitPrice } : {}),
        ...(input.stopLossPrice ? { stopLossPrice: input.stopLossPrice } : {}),
        ...(input.takeProfitPrice ? { takeProfitPrice: input.takeProfitPrice } : {}),
        origin: 'ai',
        aiDraftId: id,
        note,
      },
      preview,
      message:
        'Draft only. It opens in the ticket for the user to preview and confirm; it cannot be submitted by the copilot.',
    };
  }

  async createStrategyDraft(ctx: ToolCallCtx, input: ToolInput<'create_strategy_draft'>) {
    const s = await this.ports.strategy(ctx.user.id, ctx.user.roles, input.strategyId);
    const base = s.versions[0];
    if (!base)
      throw new NotFoundException({ error: 'not_found', message: 'Strategy has no version.' });
    const def = structuredClone(base.definition) as StrategyDefinition;
    const changes: Array<{ param: string; from: number; to: number }> = [];
    for (const ch of input.changes) {
      const p = def.params[ch.param];
      if (!p)
        throw new BadRequestException({
          error: 'unknown_param',
          message: `The strategy has no parameter "${ch.param}".`,
        });
      changes.push({ param: ch.param, from: p.value, to: ch.value });
      p.value = ch.value;
    }
    const v = await this.ports.validateStrategy(def);
    if (!v.valid || !v.contentHash) {
      throw new BadRequestException({
        error: 'invalid_strategy_draft',
        message:
          v.issues.find((i) => i.severity === 'error')?.message ??
          'The changed strategy is not valid.',
        issues: v.issues,
      });
    }
    const id = await this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO ai_strategy_drafts (user_id, strategy_id, base_version_id, definition, param_changes, content_hash, validation, rationale, model_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          ctx.user.id,
          input.strategyId,
          base.id,
          JSON.stringify(v.definition),
          JSON.stringify(changes),
          v.contentHash,
          JSON.stringify({
            valid: v.valid,
            issues: v.issues,
            shortHash: v.shortHash,
            warmupBars: v.warmupBars,
          }),
          input.rationale,
          ctx.modelId,
        ],
      );
      const draftId = r.rows[0]!.id;
      await this.audit.record(
        {
          actorId: ctx.user.id,
          actorType: ctx.author === 'user' ? 'user' : 'ai',
          action: 'ai.draft',
          entity: 'ai_strategy_draft',
          entityId: draftId,
          payload: {
            kind: 'strategy',
            origin: ctx.author === 'user' ? 'user_from_suggestion' : 'model',
            surface: ctx.surface,
            modelId: ctx.modelId,
            promptHash: ctx.promptHash,
            strategyId: input.strategyId,
            baseVersionId: base.id,
            contentHash: v.contentHash,
            changes: changes.map((x) => `${x.param}:${x.from}->${x.to}`).join(','),
            savedAsVersion: false,
          },
        },
        c,
      );
      return draftId;
    });
    return {
      draftId: id,
      status: 'draft',
      summary: {
        strategyId: input.strategyId,
        baseVersion: base.version,
        changes,
        valid: true,
        shortHash: v.shortHash,
      },
      message: 'Unapproved draft. It is not a strategy version; only the user can save it.',
    };
  }

  async get(userId: string, id: string) {
    const o = await this.db.query<Record<string, unknown>>(
      "SELECT *, 'order' AS kind FROM ai_order_drafts WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    if (o[0]) return orderDraftDto(o[0]);
    const s = await this.db.query<Record<string, unknown>>(
      "SELECT *, 'strategy' AS kind FROM ai_strategy_drafts WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    if (s[0]) return strategyDraftDto(s[0]);
    throw new NotFoundException({ error: 'not_found', message: 'Draft not found.' });
  }

  /**
   * The human decision. Accepting an order draft links the order the server bound to it when the
   * user placed it from the ticket (IRTC R4-06); accepting a strategy draft links the
   * version the user saved (authored by them, on that strategy). Rejecting just records it.
   */
  async decide(
    userId: string,
    roles: Role[],
    id: string,
    body: { decision: 'accepted' | 'rejected'; orderId?: string; versionId?: string },
  ) {
    const draft = await this.get(userId, id);
    if (draft.status !== 'draft')
      throw new ConflictException({
        error: 'already_decided',
        message: `This draft was already ${draft.status}.`,
      });
    const action = body.decision === 'accepted' ? 'ai.draft_accepted' : 'ai.draft_rejected';
    return this.db.tx(async (c) => {
      if (draft.kind === 'order') {
        let orderId: string | null = null;
        if (body.decision === 'accepted') {
          if (!body.orderId)
            throw new BadRequestException({
              error: 'order_required',
              message: 'Accepting an order draft needs the order you placed.',
            });
          // IRTC R4-06: only the order the server bound to this draft when it was placed (same
          // symbol, side, type and qty, accepted by risk), and not one that was rejected since.
          const o = await c.query<{ id: string; status: string }>(
            `SELECT o.id, o.status FROM orders o
               JOIN accounts a ON a.id = o.account_id
               JOIN ai_order_drafts d ON d.placed_order_id = o.id
              WHERE o.id = $1 AND a.user_id = $2 AND d.id = $3 AND d.user_id = $2`,
            [body.orderId, userId, id],
          );
          if (!o.rows[0] || o.rows[0].status === 'rejected') {
            throw new BadRequestException({
              error: 'order_mismatch',
              message: 'That order was not placed from this draft.',
            });
          }
          orderId = o.rows[0].id;
        }
        await c.query(
          'UPDATE ai_order_drafts SET status = $2, decided_at = clock_timestamp(), order_id = $3 WHERE id = $1',
          [id, body.decision, orderId],
        );
        const ev = await this.audit.record(
          {
            actorId: userId,
            actorType: 'user',
            action,
            entity: 'ai_order_draft',
            entityId: id,
            payload: { kind: 'order', orderId, modelId: draft.modelId },
          },
          c,
        );
        return { id, kind: 'order', status: body.decision, orderId, auditEventId: ev.id };
      }
      let versionId: string | null = null;
      if (body.decision === 'accepted') {
        if (!body.versionId)
          throw new BadRequestException({
            error: 'version_required',
            message: 'Save the version yourself first, then record it here.',
          });
        const v = await c.query<{ id: string }>(
          'SELECT id FROM strategy_versions WHERE id = $1 AND strategy_id = $2 AND author_id = $3',
          [body.versionId, draft.strategyId, userId],
        );
        if (!v.rows[0])
          throw new BadRequestException({
            error: 'version_mismatch',
            message: 'That version was not saved by you on this strategy.',
          });
        versionId = v.rows[0].id;
      }
      void roles;
      await c.query(
        'UPDATE ai_strategy_drafts SET status = $2, decided_at = clock_timestamp(), saved_version_id = $3 WHERE id = $1',
        [id, body.decision, versionId],
      );
      const ev = await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action,
          entity: 'ai_strategy_draft',
          entityId: id,
          payload: { kind: 'strategy', versionId, modelId: draft.modelId },
        },
        c,
      );
      return { id, kind: 'strategy', status: body.decision, versionId, auditEventId: ev.id };
    });
  }
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);

function orderDraftDto(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    kind: 'order' as const,
    status: r.status as string,
    surface: r.surface as string,
    symbol: r.symbol as string,
    side: r.side as string,
    type: r.type as string,
    qty: String(r.qty),
    limitPrice: (r.limit_price as string | null) ?? null,
    stopLossPrice: (r.stop_loss_price as string | null) ?? null,
    takeProfitPrice: (r.take_profit_price as string | null) ?? null,
    rationale: r.rationale as string,
    preview: r.preview,
    modelId: r.model_id as string,
    orderId: (r.order_id as string | null) ?? null,
    strategyId: null as string | null,
    createdAt: iso(r.created_at),
    decidedAt: iso(r.decided_at),
  };
}

function strategyDraftDto(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    kind: 'strategy' as const,
    status: r.status as string,
    strategyId: r.strategy_id as string,
    baseVersionId: r.base_version_id as string,
    definition: r.definition,
    changes: r.param_changes,
    contentHash: r.content_hash as string,
    validation: r.validation,
    rationale: r.rationale as string,
    modelId: r.model_id as string,
    savedVersionId: (r.saved_version_id as string | null) ?? null,
    symbol: null as string | null,
    createdAt: iso(r.created_at),
    decidedAt: iso(r.decided_at),
  };
}
